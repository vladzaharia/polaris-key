// S-08 container emulation: zstd CLI behind a tiny HTTP entrypoint.
// POST /delta?from=<url>&to=<url>&level=19&st=0  -> body: the frame; headers: X-Stats (JSON)
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"time"
)

func fetch(url, path string) (int64, error) {
	r, err := http.Get(url)
	if err != nil {
		return 0, err
	}
	defer r.Body.Close()
	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return io.Copy(f, r.Body)
}

func sum(path string) string {
	f, _ := os.Open(path)
	defer f.Close()
	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

func main() {
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	http.HandleFunc("/delta", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		st := map[string]any{}
		t := time.Now()
		if _, err := fetch(q.Get("from"), "/tmp/from"); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		if _, err := fetch(q.Get("to"), "/tmp/to"); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		st["fetchMs"] = time.Since(t).Milliseconds()
		args := []string{"-q", "-f", "--ultra", "-" + q.Get("level")}
		if q.Get("st") == "1" {
			args = append(args, "--single-thread")
		}
		args = append(args, "--patch-from=/tmp/from", "/tmp/to", "-o", "/tmp/frame")
		t = time.Now()
		cmd := exec.Command("zstd", args...)
		out, err := cmd.CombinedOutput()
		st["encodeMs"] = time.Since(t).Milliseconds()
		if err != nil {
			http.Error(w, fmt.Sprintf("encode: %v %s", err, out), 500)
			return
		}
		if ps := cmd.ProcessState; ps != nil {
			st["encodeUserMs"] = ps.UserTime().Milliseconds()
			st["encodeSysMs"] = ps.SystemTime().Milliseconds()
		}
		t = time.Now()
		dec := exec.Command("zstd", "-q", "-f", "-d", "--long=31", "--patch-from=/tmp/from", "/tmp/frame", "-o", "/tmp/check")
		if out, err := dec.CombinedOutput(); err != nil {
			http.Error(w, fmt.Sprintf("verify: %v %s", err, out), 500)
			return
		}
		st["verified"] = sum("/tmp/check") == sum("/tmp/to")
		st["verifyMs"] = time.Since(t).Milliseconds()
		if b, err := os.ReadFile("/sys/fs/cgroup/memory.peak"); err == nil {
			st["cgroupMemPeak"] = string(b[:len(b)-1])
		}
		fi, _ := os.Stat("/tmp/frame")
		st["frameBytes"] = fi.Size()
		b, _ := json.Marshal(st)
		w.Header().Set("X-Stats", string(b))
		f, _ := os.Open("/tmp/frame")
		defer f.Close()
		io.Copy(w, f)
		os.Remove("/tmp/from"); os.Remove("/tmp/to"); os.Remove("/tmp/frame"); os.Remove("/tmp/check")
	})
	http.ListenAndServe(":8080", nil)
}
