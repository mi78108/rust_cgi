#!/usr/bin/env zsh

mkdir -pv ~/Web
mkdir -pv ~/.config/systemd/user/
cp -v ./rust_cgi.service ~/.config/systemd/user/
sed -i "s/\${USERNAME}/$USER/g" ~/.config/systemd/user/rust_cgi.service
cargo build --release
systemctl --user stop rust_cgi.service
cp -v ./target/release/rust_cgi ~/Web
rsync -auv --delete ./src/cgi ~/Web/

systemctl --user daemon-reload
