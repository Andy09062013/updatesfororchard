//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

func hideWindow(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func setTitle(t string) {
	k, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return
	}
	p, err := k.FindProc("SetConsoleTitleW")
	if err != nil {
		return
	}
	s, _ := syscall.UTF16PtrFromString(t)
	p.Call(uintptr(unsafe.Pointer(s)))
}
