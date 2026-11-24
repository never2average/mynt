package main

import (
	"os"
	"syscall"
	"unsafe"
)

// AF_VSOCK, the enclave's only channel to its parent instance, with raw system calls: the standard library's syscall
// package doesn't know the address family (its Accept would close the connection on seeing it), and this keeps the
// helper free of dependencies.

const (
	afVsock      = 40
	vmaddrCidAny = 0xFFFFFFFF
)

// struct sockaddr_vm (linux/vm_sockets.h): 16 bytes.
type sockaddrVM struct {
	family    uint16
	reserved1 uint16
	port      uint32
	cid       uint32
	flags     uint8
	zero      [3]uint8
}

type vsockConn struct {
	*os.File
	fd int
}

func (c *vsockConn) CloseWrite() error { return syscall.Shutdown(c.fd, syscall.SHUT_WR) }

func vsockSocket() (int, error) {
	return syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
}

func sockcall(trap uintptr, fd int, sa *sockaddrVM) error {
	_, _, e := syscall.Syscall(trap, uintptr(fd), uintptr(unsafe.Pointer(sa)), unsafe.Sizeof(*sa))
	if e != 0 {
		return e
	}
	return nil
}

func vsockListen(port uint32) (int, error) {
	fd, err := vsockSocket()
	if err != nil {
		return -1, err
	}
	if err := sockcall(syscall.SYS_BIND, fd, &sockaddrVM{family: afVsock, port: port, cid: vmaddrCidAny}); err != nil {
		syscall.Close(fd)
		return -1, err
	}
	if err := syscall.Listen(fd, 64); err != nil {
		syscall.Close(fd)
		return -1, err
	}
	return fd, nil
}

func vsockAccept(lfd int) (*vsockConn, error) {
	for {
		nfd, _, e := syscall.Syscall6(syscall.SYS_ACCEPT4, uintptr(lfd), 0, 0, syscall.SOCK_CLOEXEC, 0, 0)
		if e == syscall.EINTR {
			continue
		}
		if e != 0 {
			return nil, e
		}
		return &vsockConn{File: os.NewFile(nfd, "vsock"), fd: int(nfd)}, nil
	}
}

func vsockDial(cid, port uint32) (*vsockConn, error) {
	fd, err := vsockSocket()
	if err != nil {
		return nil, err
	}
	for {
		err = sockcall(syscall.SYS_CONNECT, fd, &sockaddrVM{family: afVsock, port: port, cid: cid})
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return &vsockConn{File: os.NewFile(uintptr(fd), "vsock"), fd: fd}, nil
}
