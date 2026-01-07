#!/usr/bin/env zsh

mkdir -pv ~/.cgi
mkdir -pv ~/.local/bin
mkdir -pv ~/.config/systemd/user
cp -v ./rust_cgi.service ~/.config/systemd/user
sed -i "s/\${USERNAME}/$USER/g" ~/.config/systemd/user/rust_cgi.service
cargo build --release
systemctl --user stop rust_cgi.service
cp -v ./target/release/spider ~/.local/bin/rust_cgi
rsync -auv --delete ./cgi ~/.cgi

systemctl --user daemon-reload
