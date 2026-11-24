package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// The Nitro Secure Module, the enclave's only source of attestation documents. The kernel driver (include/uapi/linux/
// nsm.h) takes one ioctl, NSM_IOCTL_RAW = _IOWR(0x0A, 0, struct nsm_raw), whose argument points at a CBOR request and
// a response buffer; the module signs the document (COSE_Sign1, ES384) over the enclave's PCRs and the three fields a
// caller may set. This is the whole of the client: no other request is ever sent.

const (
	nsmDevice       = "/dev/nsm"
	nsmIoctlRaw     = 0xC0200A00 // _IOWR(0x0A, 0, 32 bytes)
	nsmResponseMax  = 0x3000
	nsmMaxUserData  = 512
	nsmMaxNonce     = 512
	nsmMaxPublicKey = 1024
)

type nsmIovec struct {
	addr uint64
	len  uint64
}

type nsmRaw struct {
	request  nsmIovec
	response nsmIovec
}

// The request, as the module's own API serialises Request::Attestation: an externally tagged map.
func attestationRequest(nonce, userData, publicKey []byte) ([]byte, error) {
	if len(nonce) > nsmMaxNonce || len(userData) > nsmMaxUserData || len(publicKey) > nsmMaxPublicKey {
		return nil, errors.New("attestation field too long")
	}
	b := append(cborHead(5, 1), cborText("Attestation")...)
	b = append(b, cborHead(5, 3)...)
	b = append(b, cborText("nonce")...)
	b = append(b, cborBytesOrNull(nonce)...)
	b = append(b, cborText("public_key")...)
	b = append(b, cborBytesOrNull(publicKey)...)
	b = append(b, cborText("user_data")...)
	b = append(b, cborBytesOrNull(userData)...)
	return b, nil
}

// The document from Response::Attestation { document }, or the module's error.
func attestationDocument(resp []byte) ([]byte, error) {
	v, err := cborDecode(resp)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errCbor
	}
	if e, ok := m["Error"]; ok {
		return nil, fmt.Errorf("the security module refused: %v", e)
	}
	a, ok := m["Attestation"].(map[string]any)
	if !ok {
		return nil, errCbor
	}
	doc, ok := a["document"].([]byte)
	if !ok || len(doc) == 0 {
		return nil, errCbor
	}
	return doc, nil
}

func nsmAttest(nonce, userData, publicKey []byte) ([]byte, error) {
	req, err := attestationRequest(nonce, userData, publicKey)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(nsmDevice, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	resp := make([]byte, nsmResponseMax)
	msg := nsmRaw{
		request:  nsmIovec{addr: uint64(uintptr(unsafe.Pointer(&req[0]))), len: uint64(len(req))},
		response: nsmIovec{addr: uint64(uintptr(unsafe.Pointer(&resp[0]))), len: uint64(len(resp))},
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), nsmIoctlRaw, uintptr(unsafe.Pointer(&msg)))
	runtime.KeepAlive(req)
	runtime.KeepAlive(resp)
	if errno != 0 {
		return nil, errno
	}
	if msg.response.len > uint64(len(resp)) {
		return nil, errCbor
	}
	return attestationDocument(resp[:msg.response.len])
}
