// OrchardSetup: a small installer for Orchard, the battery saving browser.
//
// It downloads the Chromium engine (Electron, from Electron's official GitHub
// release) and Orchard's own files (from the updatesfororchard repo), checks
// every file's SHA-256, installs to %LOCALAPPDATA%\Programs\Orchard, puts the
// apple icon on Orchard.exe, registers an uninstaller in Windows Settings and
// opens Orchard. Run with --uninstall to remove it.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	repoBase    = "https://raw.githubusercontent.com/Andy09062013/updatesfororchard/main/"
	electronURL = "https://github.com/electron/electron/releases/download/v%s/electron-v%s-win32-x64.zip"
)

const (
	electronVer    = "45.2.3"
	electronSHA256 = "489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0"
	uninstallKey   = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Orchard`
)

//go:embed icons/*.png
var icons embed.FS

// installer.json in the repo can point new installs at a newer engine later
type engineInfo struct {
	ElectronVersion string `json:"electronVersion"`
	ElectronSHA256  string `json:"electronSha256"`
}

type manifest struct {
	Version string `json:"version"`
	Files   []struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	} `json:"files"`
}

var client = &http.Client{Timeout: 30 * time.Minute}

func main() {
	setTitle("Orchard Setup")
	installDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Orchard")
	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		uninstall(installDir)
		return
	}
	fmt.Println()
	fmt.Println("   ORCHARD  -  the battery saving browser")
	fmt.Println("   ======================================")
	fmt.Println()
	if err := install(installDir); err != nil {
		fmt.Println()
		fmt.Println("   Something went wrong:", err)
		fmt.Println("   Check ur internet and run OrchardSetup again.")
		pause()
		os.Exit(1)
	}
}

func install(dir string) error {
	tmp, err := os.MkdirTemp("", "orchard-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	// 0. which engine + which Orchard version
	eng := engineInfo{ElectronVersion: electronVer, ElectronSHA256: electronSHA256}
	if b, err := get(repoBase + "installer.json"); err == nil {
		var e engineInfo
		if json.Unmarshal(b, &e) == nil && e.ElectronVersion != "" && len(e.ElectronSHA256) == 64 {
			eng = e
		}
	}
	mb, err := get(repoBase + "version.json?t=" + fmt.Sprint(time.Now().Unix()))
	if err != nil {
		return fmt.Errorf("couldn't reach the Orchard repo (%v)", err)
	}
	var man manifest
	if err := json.Unmarshal(mb, &man); err != nil || man.Version == "" {
		return errors.New("the Orchard repo's version.json is broken")
	}
	fmt.Printf("   Installing Orchard %s\n\n", man.Version)

	// 1. engine
	zipPath := filepath.Join(tmp, "engine.zip")
	url := fmt.Sprintf(electronURL, eng.ElectronVersion, eng.ElectronVersion)
	fmt.Println("   [1/4] Downloading the browser engine (about 150 MB)...")
	sum, err := download(url, zipPath)
	if err != nil {
		return fmt.Errorf("engine download failed: %v", err)
	}
	if sum != eng.ElectronSHA256 {
		return errors.New("the engine download got corrupted, try again")
	}

	// 2. unpack
	fmt.Println("\n   [2/4] Unpacking...")
	killRunning(dir)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("close Orchard first, then try again (%v)", err)
	}
	if err := unzip(zipPath, dir); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(dir, "electron.exe"), filepath.Join(dir, "Orchard.exe")); err != nil {
		return err
	}
	os.Remove(filepath.Join(dir, "resources", "default_app.asar"))

	// 3. Orchard's own files
	fmt.Println("   [3/4] Downloading Orchard's files...")
	appDir := filepath.Join(dir, "resources", "app")
	safe := regexp.MustCompile(`^[A-Za-z0-9_\-][A-Za-z0-9_.\-/]*$`)
	for _, f := range man.Files {
		if !safe.MatchString(f.Path) || strings.Contains(f.Path, "..") {
			return fmt.Errorf("bad file name in version.json: %s", f.Path)
		}
		b, err := get(repoBase + "app/" + f.Path + "?v=" + man.Version)
		if err != nil {
			return fmt.Errorf("couldn't download %s (%v)", f.Path, err)
		}
		h := sha256.Sum256(b)
		if f.SHA256 != "" && hex.EncodeToString(h[:]) != f.SHA256 {
			return fmt.Errorf("%s got corrupted on the way, try again", f.Path)
		}
		out := filepath.Join(appDir, filepath.FromSlash(f.Path))
		os.MkdirAll(filepath.Dir(out), 0o755)
		if err := os.WriteFile(out, b, 0o644); err != nil {
			return err
		}
	}

	// 4. apple icon, uninstaller, open
	fmt.Println("   [4/4] Finishing up...")
	exe := filepath.Join(dir, "Orchard.exe")
	if err := patchIcon(exe); err != nil {
		fmt.Println("         (couldn't set the exe icon, Orchard still works:", err, ")")
	}
	self, _ := os.Executable()
	if b, err := os.ReadFile(self); err == nil {
		os.WriteFile(filepath.Join(dir, "OrchardSetup.exe"), b, 0o755)
	}
	unin := `"` + filepath.Join(dir, "OrchardSetup.exe") + `" --uninstall`
	for _, kv := range [][2]string{{"DisplayName", "Orchard"}, {"DisplayVersion", man.Version}, {"Publisher", "Orchard"}, {"DisplayIcon", exe}, {"InstallLocation", dir}, {"UninstallString", unin}} {
		run("reg", "add", uninstallKey, "/v", kv[0], "/t", "REG_SZ", "/d", kv[1], "/f")
	}
	run("reg", "add", uninstallKey, "/v", "NoModify", "/t", "REG_DWORD", "/d", "1", "/f")

	cmd := exec.Command(exe)
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("installed, but couldn't open Orchard: %v", err)
	}
	fmt.Println()
	fmt.Println("   Done! Orchard is open. It'll update itself from now on.")
	fmt.Println("   U'll find it in the Start menu and on ur desktop.")
	time.Sleep(4 * time.Second)
	return nil
}

func uninstall(dir string) {
	fmt.Println()
	fmt.Println("   Uninstalling Orchard...")
	killRunning(dir)
	time.Sleep(time.Second)
	for _, p := range []string{
		filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "Orchard.lnk"),
		filepath.Join(os.Getenv("USERPROFILE"), "Desktop", "Orchard.lnk"),
	} {
		os.Remove(p)
	}
	run("reg", "delete", uninstallKey, "/f")
	// we're running from inside the folder, so delete it a moment after we exit
	run("cmd", "/c", "start", "", "/min", "cmd", "/c", "timeout /t 2 /nobreak >nul & rmdir /s /q \""+dir+"\"")
	fmt.Println("   Orchard is uninstalled. Ur bookmarks and settings are still in")
	fmt.Println("   %APPDATA%\\Orchard if u ever come back.")
	time.Sleep(3 * time.Second)
}

// ---------- helpers ----------

func get(url string) ([]byte, error) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("server said %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

type progress struct {
	total, done int64
	last        time.Time
}

func (p *progress) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if time.Since(p.last) > 200*time.Millisecond || p.done == p.total {
		p.last = time.Now()
		if p.total > 0 {
			pct := float64(p.done) / float64(p.total)
			bar := int(pct * 30)
			fmt.Printf("\r         [%s%s] %3.0f%%  %d/%d MB ", strings.Repeat("#", bar), strings.Repeat("-", 30-bar), pct*100, p.done>>20, p.total>>20)
		} else {
			fmt.Printf("\r         %d MB ", p.done>>20)
		}
	}
	return len(b), nil
}

func download(url, dst string) (string, error) {
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("server said %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h, &progress{total: resp.ContentLength}), resp.Body)
	return hex.EncodeToString(h.Sum(nil)), err
}

func unzip(src, dst string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	root, _ := filepath.Abs(dst)
	for _, f := range r.File {
		p := filepath.Join(root, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, root+string(os.PathSeparator)) && p != root {
			return fmt.Errorf("bad path in engine zip: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(p)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func run(name string, args ...string) {
	c := exec.Command(name, args...)
	hideWindow(c)
	c.Run()
}

func killRunning(dir string) {
	if _, err := os.Stat(filepath.Join(dir, "Orchard.exe")); err == nil {
		run("taskkill", "/IM", "Orchard.exe", "/F")
		time.Sleep(800 * time.Millisecond)
	}
}

func pause() {
	fmt.Println("\n   Press Enter to close.")
	fmt.Scanln()
}


// patchIcon swaps the Electron icons inside Orchard.exe for the apple, in place.
func patchIcon(exe string) error {
	d, err := os.ReadFile(exe)
	if err != nil {
		return err
	}
	le := binary.LittleEndian
	pe := int(le.Uint32(d[0x3c:]))
	if !bytes.Equal(d[pe:pe+4], []byte("PE\x00\x00")) {
		return errors.New("not a PE file")
	}
	nsec := int(le.Uint16(d[pe+6:]))
	optsz := int(le.Uint16(d[pe+20:]))
	opt := pe + 24
	dd := opt + 96
	if le.Uint16(d[opt:]) == 0x20b {
		dd = opt + 112
	}
	rsrcRVA := le.Uint32(d[dd+16:])
	type sec struct{ va, size, raw uint32 }
	var secs []sec
	for i := 0; i < nsec; i++ {
		o := opt + optsz + i*40
		vs, va, rs, rp := le.Uint32(d[o+8:]), le.Uint32(d[o+12:]), le.Uint32(d[o+16:]), le.Uint32(d[o+20:])
		if rs > vs {
			vs = rs
		}
		secs = append(secs, sec{va, vs, rp})
	}
	off := func(rva uint32) int {
		for _, s := range secs {
			if rva >= s.va && rva < s.va+s.size {
				return int(rva - s.va + s.raw)
			}
		}
		return -1
	}
	base := off(rsrcRVA)
	if base < 0 {
		return errors.New("no resources")
	}
	type ent struct{ name, ofs uint32 }
	entries := func(o int) []ent {
		n := int(le.Uint16(d[o+12:])) + int(le.Uint16(d[o+14:]))
		var out []ent
		for i := 0; i < n; i++ {
			out = append(out, ent{le.Uint32(d[o+16+i*8:]), le.Uint32(d[o+20+i*8:])})
		}
		return out
	}
	leaf := func(ofs uint32) int {
		for ofs&0x80000000 != 0 {
			es := entries(base + int(ofs&0x7fffffff))
			if len(es) == 0 {
				return -1
			}
			ofs = es[0].ofs
		}
		return base + int(ofs)
	}
	iconData := map[uint32]int{}
	group := -1
	for _, e := range entries(base) {
		if e.name == 3 {
			for _, e2 := range entries(base + int(e.ofs&0x7fffffff)) {
				iconData[e2.name] = leaf(e2.ofs)
			}
		}
		if e.name == 14 {
			es := entries(base + int(e.ofs&0x7fffffff))
			if len(es) > 0 {
				group = leaf(es[0].ofs)
			}
		}
	}
	if group < 0 {
		return errors.New("no icon group")
	}
	g := off(le.Uint32(d[group:]))
	cnt := int(le.Uint16(d[g+4:]))
	changed := 0
	for i := 0; i < cnt; i++ {
		e := g + 6 + i*14
		w := int(d[e])
		if w == 0 {
			w = 256
		}
		id := uint32(le.Uint16(d[e+12:]))
		de, ok := iconData[id]
		if !ok || de < 0 {
			continue
		}
		png, err := icons.ReadFile(fmt.Sprintf("icons/%d.png", w))
		if err != nil {
			continue
		}
		size := int(le.Uint32(d[de+4:]))
		fo := off(le.Uint32(d[de:]))
		if fo < 0 || len(png) > size {
			continue
		}
		copy(d[fo:fo+size], append(png, make([]byte, size-len(png))...))
		le.PutUint32(d[de+4:], uint32(len(png)))
		d[e+2], d[e+3] = 0, 0
		le.PutUint16(d[e+4:], 1)
		le.PutUint16(d[e+6:], 32)
		le.PutUint32(d[e+8:], uint32(len(png)))
		changed++
	}
	if changed == 0 {
		return errors.New("no icons replaced")
	}
	return os.WriteFile(exe, d, 0o755)
}
