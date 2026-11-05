package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// full install against a local copy of the repo + the real Electron zip
func TestInstall(t *testing.T) {
	mux := http.NewServeMux()
	mux.Handle("/repo/", http.StripPrefix("/repo/", http.FileServer(http.Dir("/home/claude/updatesfororchard"))))
	mux.HandleFunc("/engine.zip", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, "/home/claude/dl/electron-win.zip") })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	repoBase = srv.URL + "/repo/"
	electronURL = srv.URL + "/engine.zip?%s%s"
	dir := filepath.Join(t.TempDir(), "Orchard")
	os.Setenv("LOCALAPPDATA", t.TempDir())
	if err := install(dir); err != nil && err.Error()[:9] != "installed" {
		t.Fatal(err)
	}
	for _, f := range []string{"Orchard.exe", "resources/app/main.js", "resources/app/package.json", "resources/app/boot.js", "ffmpeg.dll"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatal("missing", f)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "resources/default_app.asar")); err == nil {
		t.Fatal("default_app.asar left behind")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "Orchard.exe"))
	os.WriteFile("/tmp/claude-0/-home-claude/0b3f5e5b-209d-5d16-9220-0a40516a274f/scratchpad/installed-Orchard.exe", b, 0o644)
}
