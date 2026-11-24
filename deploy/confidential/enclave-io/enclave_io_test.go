package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"testing"
	"unsafe"
)

func TestAttestationRequestIsTheModulesExternallyTaggedMap(t *testing.T) {
	req, err := attestationRequest([]byte("nonce"), nil, []byte{1, 2})
	if err != nil {
		t.Fatal(err)
	}
	v, err := cborDecode(req)
	if err != nil {
		t.Fatal(err)
	}
	a := v.(map[string]any)["Attestation"].(map[string]any)
	if !bytes.Equal(a["nonce"].([]byte), []byte("nonce")) || a["user_data"] != nil || !bytes.Equal(a["public_key"].([]byte), []byte{1, 2}) {
		t.Fatalf("unexpected request %#v", a)
	}
	if _, err := attestationRequest(make([]byte, 513), nil, nil); err == nil {
		t.Fatal("an over-long nonce must be refused")
	}
}

func TestAttestationDocumentAndErrors(t *testing.T) {
	doc := []byte{0xd2, 0x84}
	resp := append(cborHead(5, 1), cborText("Attestation")...)
	resp = append(resp, cborHead(5, 1)...)
	resp = append(resp, cborText("document")...)
	resp = append(resp, cborBytesOrNull(doc)...)
	got, err := attestationDocument(resp)
	if err != nil || !bytes.Equal(got, doc) {
		t.Fatalf("got %x, %v", got, err)
	}
	refused := append(cborHead(5, 1), cborText("Error")...)
	refused = append(refused, cborText("InvalidArgument")...)
	if _, err := attestationDocument(refused); err == nil {
		t.Fatal("the module's error must surface")
	}
	for _, bad := range [][]byte{{}, {0xbf}, {0x5f}, append(resp, 0)} {
		if _, err := attestationDocument(bad); err == nil {
			t.Fatalf("%x must be refused", bad)
		}
	}
}

func TestIoctlStructsMatchTheKernel(t *testing.T) {
	if unsafe.Sizeof(nsmRaw{}) != 32 || unsafe.Sizeof(sockaddrVM{}) != 16 {
		t.Fatal("struct sizes differ from the kernel's")
	}
	if nsmIoctlRaw != (3<<30)|(32<<16)|(0x0A<<8) {
		t.Fatal("NSM_IOCTL_RAW is wrong")
	}
}

func TestRelayCarriesBothWaysAndPassesEndOfStream(t *testing.T) {
	dir := t.TempDir()
	back, err := listenUnix(filepath.Join(dir, "back.sock"), -1, -1)
	if err != nil {
		t.Fatal(err)
	}
	front, err := listenUnix(filepath.Join(dir, "front.sock"), -1, -1)
	if err != nil {
		t.Fatal(err)
	}
	go relay("test", acceptUnix(front), dialUnix(filepath.Join(dir, "back.sock")))
	go func() {
		c, err := back.AcceptUnix()
		if err != nil {
			return
		}
		got, _ := io.ReadAll(c) // until the client's end of stream arrives through the relay
		c.Write(append([]byte("echo:"), got...))
		c.CloseWrite()
	}()
	c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: filepath.Join(dir, "front.sock"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("hello"))
	c.CloseWrite()
	got, _ := io.ReadAll(c)
	if string(got) != "echo:hello" {
		t.Fatalf("got %q", got)
	}
}

func TestAttestationSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nsm.sock")
	l, err := listenUnix(path, -1, -1)
	if err != nil {
		t.Fatal(err)
	}
	var seen [3][]byte
	go serveAttestation(l, func(n, u, p []byte) ([]byte, error) {
		seen = [3][]byte{n, u, p}
		return []byte("doc"), nil
	})
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	json.NewEncoder(c).Encode(map[string]string{"nonce": base64.StdEncoding.EncodeToString([]byte("n1")), "user_data": base64.StdEncoding.EncodeToString([]byte("u1"))})
	var out map[string]string
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if d, _ := base64.StdEncoding.DecodeString(out["document"]); string(d) != "doc" {
		t.Fatalf("got %v", out)
	}
	if string(seen[0]) != "n1" || string(seen[1]) != "u1" || seen[2] != nil {
		t.Fatalf("module saw %q", seen)
	}
}
