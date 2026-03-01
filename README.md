# HIPAA Agent

## One-command Docker run (local or EC2)

1) Create your env file:

```bash
cp .env.example .env
```

2) Set at least `OPENAI_API_KEY` in `.env` (and optionally GitHub App vars).

3) Build + start:

```bash
docker compose up -d --build
```

Open the UI:
- Local: `http://localhost`
- EC2: `http://YOUR_EC2_PUBLIC_IP`

Stop:

```bash
docker compose down
```

Data is persisted in the Docker volume `hipaa_agent_data`.

## EC2 quick steps (Ubuntu)

1) Launch an Ubuntu instance (t3.small+ recommended).
2) Security Group inbound: allow `80/tcp` (and `22/tcp` for SSH; `443/tcp` if you add TLS later).
3) SSH in, then:

```bash
sudo apt-get update
sudo apt-get install -y git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

4) Clone your repo onto the instance, create `.env`, then:

```bash
docker compose up -d --build
```

