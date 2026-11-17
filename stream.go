package main

// The stream server: a loopback-only HTTP server for what has to stream
// (terminal output now, chat replies next). The page's own scheme can't
// carry a WebSocket, so it learns this server's address and key from
// /api/backend and connects here. Every request must carry the key.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"log"
	"net"
	"net/http"
)

type StreamServer struct {
	URL   string // http://127.0.0.1:<port>
	Token string
	mux   *http.ServeMux
}

func NewStreamServer() (*StreamServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	s := &StreamServer{URL: "http://" + ln.Addr().String(), Token: hex.EncodeToString(b), mux: http.NewServeMux()}
	go func() {
		if err := http.Serve(ln, s); err != nil {
			log.Printf("stream server: %v", err)
		}
	}()
	return s, nil
}

func (s *StreamServer) Handle(pattern string, h http.Handler) { s.mux.Handle(pattern, h) }

func (s *StreamServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	got := r.URL.Query().Get("key")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.mux.ServeHTTP(w, r)
}
