#!/usr/bin/env zsh

BIN_NAME=target/release/spider
mkdir -pv "${HOME}"/{.cgi,.local/bin,.config/systemd/user}
cargo build --release && cp -v $BIN_NAME ${HOME}/.local/bin/rust_cgi

cat > "${HOME}"/.config/systemd/user/rust_cgi.service <<EOF
[Unit]
Description=Rust_CGI Program

[Service]
Type=simple
Environment="RUST_LOG=debug"
ExecStart=${HOME}/.local/bin/spider -v -b0.0.0.0 -f${HOME}/.cgi

[Install]
WantedBy=default.target
EOF
echo "install finished"