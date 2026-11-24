package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"sync"
)

// Byte relays between the enclave's vsock and the Unix sockets the service uses, so the service (Node, which has no
// vsock) never needs a native module. Each relay carries bytes only: TLS to Mynt's server and to KMS runs end to end
// inside the service, so nothing here can read or change what passes.

type halfConn interface {
	io.ReadWriteCloser
	CloseWrite() error
}

// pipe copies both ways, passing each side's end of stream on, and closes both when both directions are done.
func pipe(a, b halfConn) {
	var wg sync.WaitGroup
	wg.Add(2)
	one := func(dst, src halfConn) {
		defer wg.Done()
		io.Copy(dst, src)
		dst.CloseWrite()
	}
	go one(a, b)
	go one(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}

// relay accepts connections and joins each to a fresh one from dial, until accept fails.
func relay(name string, accept func() (halfConn, error), dial func() (halfConn, error)) {
	for {
		in, err := accept()
		if err != nil {
			log.Printf("enclave-io: %s stopped accepting: %v", name, err)
			return
		}
		go func() {
			out, err := dial()
			if err != nil {
				log.Printf("enclave-io: %s couldn't connect onward: %v", name, err)
				in.Close()
				return
			}
			pipe(in, out)
		}()
	}
}

// A Unix socket only the service's user may use: created, then chowned and restricted before anyone can connect.
func listenUnix(path string, uid, gid int) (*net.UnixListener, error) {
	os.Remove(path)
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if uid >= 0 {
		if err := os.Chown(path, uid, gid); err != nil {
			l.Close()
			return nil, err
		}
	}
	if err := os.Chmod(path, 0o600); err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
}

func acceptUnix(l *net.UnixListener) func() (halfConn, error) {
	return func() (halfConn, error) { return l.AcceptUnix() }
}

func dialUnix(path string) func() (halfConn, error) {
	return func() (halfConn, error) {
		return net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	}
}

// The attestation endpoint the service calls: one JSON request line, one JSON answer, then the connection closes.
// Fields are base64; the module enforces its own limits again.
type attestRequest struct {
	Nonce     string `json:"nonce"`
	UserData  string `json:"user_data"`
	PublicKey string `json:"public_key"`
}

func optionalB64(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}

func serveAttestation(l *net.UnixListener, attest func(nonce, userData, publicKey []byte) ([]byte, error)) {
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			log.Printf("enclave-io: attestation stopped accepting: %v", err)
			return
		}
		go func() {
			defer c.Close()
			reply := func(v any) { json.NewEncoder(c).Encode(v) }
			line, err := bufio.NewReader(io.LimitReader(c, 8192)).ReadBytes('\n')
			if err != nil && len(line) == 0 {
				return
			}
			var req attestRequest
			if json.Unmarshal(line, &req) != nil {
				reply(map[string]string{"error": "bad_request"})
				return
			}
			nonce, e1 := optionalB64(req.Nonce)
			userData, e2 := optionalB64(req.UserData)
			publicKey, e3 := optionalB64(req.PublicKey)
			if e1 != nil || e2 != nil || e3 != nil {
				reply(map[string]string{"error": "bad_base64"})
				return
			}
			doc, err := attest(nonce, userData, publicKey)
			if err != nil {
				log.Printf("enclave-io: attestation failed: %v", err)
				reply(map[string]string{"error": "attestation_failed"})
				return
			}
			reply(map[string]string{"document": base64.StdEncoding.EncodeToString(doc)})
		}()
	}
}
