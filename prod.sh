#!/usr/bin/env bash

sudo docker rm -f $(sudo docker ps -a -q --filter ancestor=trop --format="{{.ID}}") > /dev/null
sudo ./docker/run
sudo docker build . -t trop
sudo docker run -d --restart=always -p 3000:3000 --name trop --link trop-runner trop