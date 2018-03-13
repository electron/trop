#!/usr/bin/env bash

sudo docker rm -f $(sudo docker ps -a -q --filter ancestor=trop --format="{{.ID}}") > /dev/null
sudo ./docker/run
sudo docker build . -t trop
sudo docker run -d --restart=always -p 127.0.0.1:3000:3000 trop