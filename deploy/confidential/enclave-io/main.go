// mynt-enclave-io: the keyhouse's only native piece inside an AWS Nitro enclave (docs/reference.md, Confidential
// computing). An enclave has no network, no disk and no console in production: only vsock to its parent instance and
// the Nitro Secure Module. The service is Node, which can use neither, so this helper, started as the enclave's entry
// point, does exactly three things and then runs the service as an unprivileged user:
//
//   - relays bytes between vsock ports and Unix sockets in /run/keyhouse (TLS runs end to end inside the service, so the
//     relays and the parent see ciphertext only);
//   - answers attestation requests on /run/keyhouse/nsm.sock from the Nitro Secure Module, so only this helper opens
//     /dev/nsm;
//   - sends the service's log lines (route, caller and outcome only) to the parent, which has no other way to see them.
//
// Written for this repository with the Go standard library only (no modules to fetch, so the build is reproducible
// from go.mod alone), and built static with -trimpath into the image the enclave measures (deploy/confidential/Dockerfile).
//
// Ports, all on the parent (CID 3) except the first, which the enclave listens on. deploy/confidential/aws/parent-setup.sh
// runs the other ends:
//
//	8443  inbound: the parent forwards Mynt's server's TLS connection here -> /run/keyhouse/https.sock
//	8000  /run/keyhouse/kms.sock -> the parent's vsock-proxy for the region's KMS endpoint
//	8001  /run/keyhouse/imds.sock -> the parent's relay to the instance metadata service (the role's credentials)
//	8002  /run/keyhouse/config.sock -> the parent's settings file for the service (non-secret; bound into the attestation)
//	8003  the service's stdout and stderr -> the parent's journal
package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

const (
	parentCID   = 3
	portInbound = 8443
	portKMS     = 8000
	portIMDS    = 8001
	portConfig  = 8002
	portLogs    = 8003
	runDir      = "/run/keyhouse"
	serviceUID  = 1000
	serviceGID  = 1000
)

func main() {
	if len(os.Args) >= 3 && os.Args[1] == "run" && os.Args[2] == "--" && len(os.Args) > 3 {
		os.Exit(run(os.Args[3:]))
	}
	fmt.Fprintln(os.Stderr, "usage: mynt-enclave-io run -- <command> [args…]")
	os.Exit(2)
}

func must(what string, err error) {
	if err != nil {
		log.Fatalf("enclave-io: %s: %v", what, err)
	}
}

func run(command []string) int {
	must("run directory", os.MkdirAll(runDir, 0o750))
	must("run directory owner", os.Chown(runDir, serviceUID, serviceGID))

	for _, out := range []struct {
		name string
		port uint32
	}{{"kms", portKMS}, {"imds", portIMDS}, {"config", portConfig}} {
		l, err := listenUnix(runDir+"/"+out.name+".sock", serviceUID, serviceGID)
		must(out.name, err)
		port := out.port
		go relay(out.name, acceptUnix(l), func() (halfConn, error) { return vsockDial(parentCID, port) })
	}

	nsm, err := listenUnix(runDir+"/nsm.sock", serviceUID, serviceGID)
	must("attestation socket", err)
	go serveAttestation(nsm, nsmAttest)

	in, err := vsockListen(portInbound)
	must("inbound vsock", err)
	go relay("inbound", func() (halfConn, error) { return vsockAccept(in) }, dialUnix(runDir+"/https.sock"))

	// The service's output goes to the parent when it's listening, and to the console (seen only in debug mode) too.
	var logs io.Writer = os.Stdout
	if c, err := vsockDial(parentCID, portLogs); err == nil {
		logs = io.MultiWriter(os.Stdout, c)
	}

	cmd := exec.Command(command[0], command[1:]...)
	cmd.Stdout, cmd.Stderr, cmd.Env = logs, logs, os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: serviceUID, Gid: serviceGID}}
	must("start the service", cmd.Start())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		for s := range sig {
			cmd.Process.Signal(s)
		}
	}()
	if err := cmd.Wait(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		return 1
	}
	return 0
}
