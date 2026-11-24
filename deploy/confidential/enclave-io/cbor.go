package main

import (
	"encoding/binary"
	"errors"
	"math"
)

// The little CBOR (RFC 8949) the Nitro Secure Module speaks: a request is a map of text keys to byte strings or null,
// and a response is a map of text keys to maps, byte strings or text. Definite lengths only, which is all the module
// writes; anything else is refused rather than guessed at.

func cborHead(major byte, n uint64) []byte {
	m := major << 5
	switch {
	case n < 24:
		return []byte{m | byte(n)}
	case n <= math.MaxUint8:
		return []byte{m | 24, byte(n)}
	case n <= math.MaxUint16:
		b := []byte{m | 25, 0, 0}
		binary.BigEndian.PutUint16(b[1:], uint16(n))
		return b
	case n <= math.MaxUint32:
		b := []byte{m | 26, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(b[1:], uint32(n))
		return b
	default:
		b := []byte{m | 27, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint64(b[1:], n)
		return b
	}
}

func cborText(s string) []byte { return append(cborHead(3, uint64(len(s))), s...) }

// A byte string, or null when b is nil.
func cborBytesOrNull(b []byte) []byte {
	if b == nil {
		return []byte{0xf6}
	}
	return append(cborHead(2, uint64(len(b))), b...)
}

var errCbor = errors.New("malformed CBOR from the security module")

type cborReader struct {
	b []byte
	i int
}

func (r *cborReader) head() (byte, uint64, error) {
	if r.i >= len(r.b) {
		return 0, 0, errCbor
	}
	ib := r.b[r.i]
	r.i++
	major, info := ib>>5, ib&0x1f
	var n uint64
	switch {
	case info < 24:
		n = uint64(info)
	case info <= 27:
		size := 1 << (info - 24)
		if r.i+size > len(r.b) {
			return 0, 0, errCbor
		}
		for _, x := range r.b[r.i : r.i+size] {
			n = n<<8 | uint64(x)
		}
		r.i += size
	default:
		return 0, 0, errCbor // indefinite lengths and reserved values
	}
	return major, n, nil
}

// decode returns uint64, int64 (negative), []byte, string, []any, map[string]any (text keys only), bool or nil.
func (r *cborReader) decode(depth int) (any, error) {
	if depth > 16 {
		return nil, errCbor
	}
	major, n, err := r.head()
	if err != nil {
		return nil, err
	}
	switch major {
	case 0:
		return n, nil
	case 1:
		if n > math.MaxInt64 {
			return nil, errCbor
		}
		return -1 - int64(n), nil
	case 2, 3:
		if n > uint64(len(r.b)-r.i) {
			return nil, errCbor
		}
		v := r.b[r.i : r.i+int(n)]
		r.i += int(n)
		if major == 3 {
			return string(v), nil
		}
		return append([]byte(nil), v...), nil
	case 4:
		if n > uint64(len(r.b)) {
			return nil, errCbor
		}
		out := make([]any, 0, n)
		for k := uint64(0); k < n; k++ {
			v, err := r.decode(depth + 1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case 5:
		if n > uint64(len(r.b)) {
			return nil, errCbor
		}
		out := make(map[string]any, n)
		for k := uint64(0); k < n; k++ {
			key, err := r.decode(depth + 1)
			if err != nil {
				return nil, err
			}
			ks, ok := key.(string)
			if !ok {
				return nil, errCbor
			}
			v, err := r.decode(depth + 1)
			if err != nil {
				return nil, err
			}
			out[ks] = v
		}
		return out, nil
	case 7:
		switch n {
		case 20:
			return false, nil
		case 21:
			return true, nil
		case 22, 23:
			return nil, nil
		}
	}
	return nil, errCbor
}

func cborDecode(b []byte) (any, error) {
	r := &cborReader{b: b}
	v, err := r.decode(0)
	if err != nil {
		return nil, err
	}
	if r.i != len(b) {
		return nil, errCbor
	}
	return v, nil
}
