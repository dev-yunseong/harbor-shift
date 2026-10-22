<div align="center">

# Harbor Shift

HTTP/WebSocket 서비스를 위한 Docker blue-green 배포 도구입니다.

[빠른 시작](#빠른-시작) · [사용 문서](#사용-문서)

</div>

`harbor.yml`에 앱의 `docker run` 명령 또는 Compose 파일을 지정하면 Harbor Shift가 blue/green 컨테이너를 생성하고 이미지 업데이트를 감지합니다. 새 요청을 새 버전으로 전환한 뒤 기존 작업이 끝나기를 기다립니다. blue와 green은 서로 다른 실행 정의를 사용할 수 있습니다.

## 빠른 시작

Linux Docker Engine (`linux/amd64`)과 GHCR 이미지가 필요합니다. 전용 작업 폴더를 만들고 아래 파일을 저장하세요. 이미지가 private이면 먼저 읽기 권한으로 로그인해야 합니다. [CI 게시 상태](https://github.com/dev-yunseong/harbor-shift/actions/workflows/test.yml)를 확인하세요.

### 1. harbor.yml 작성

```yaml
group: harbor-web
network: harbor-demo
source:
  dockerRun: docker run --network harbor-demo --memory 128m --cpus 1 -p 8080:80 traefik/whoami:v1.11
readinessPath: /
shutdown:
  mode: docker
timing:
  drainMs: 3600000
  stopSeconds: 120
```

`source.dockerRun`은 **대상 앱의 실행 정의**입니다. 아래에서 실행하는 Harbor Shift 컨테이너와 다릅니다. 명령을 shell에서 실행하지 않고 읽어서 슬롯 컨테이너를 만듭니다. `-p`의 앱 내부 포트는 사용하지만 호스트 포트는 슬롯에 직접 공개하지 않습니다. 외부 접속은 프록시 포트로 받습니다.

Compose 파일을 사용하려면 `source`를 다음처럼 바꾸세요. 해당 파일과 참조하는 env 파일도 같은 작업 폴더에 두세요. [앱 Compose 예제와 슬롯별 설정](docs/service-sources.md)

```yaml
source:
  composeFile: ./app.compose.yml
  service: web
```

### 2. Harbor Shift 실행

다음 두 방법 중 하나를 선택하세요.

**docker run**

```sh
docker network create harbor-demo
docker volume create harbor-state
docker pull ghcr.io/dev-yunseong/harbor-shift:latest

docker run -d \
  --name harbor-shift --network harbor-demo \
  --restart=no --stop-timeout 5400 \
  -p 127.0.0.1:8080:8080 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$(pwd),dst=/config,readonly" \
  --mount type=volume,src=harbor-state,dst=/state \
  ghcr.io/dev-yunseong/harbor-shift:latest /config/harbor.yml --apply
```

네트워크와 volume이 이미 있다면 용도를 확인한 뒤 재사용하세요.

**Docker Compose** — 아래 내용을 같은 폴더의 `compose.yaml`로 저장하세요.

```yaml
services:
  harbor-shift:
    image: ghcr.io/dev-yunseong/harbor-shift:latest
    command: ["/config/harbor.yml", "--apply"]
    ports: ["127.0.0.1:8080:8080"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./:/config:ro
      - harbor-state:/state
    networks: [harbor]
    restart: "no"
    stop_grace_period: 90m
networks:
  harbor:
    name: harbor-demo
volumes:
  harbor-state:
```

```sh
docker compose pull
docker compose up -d
```

`curl http://localhost:8080`으로 접속을 확인하세요. 외부 공개 시 앞단에서 TLS를 처리해야 합니다. 기존 작업은 최대 1시간, SIGTERM 이후에는 최대 2분 기다립니다. 실제 작업 시간에 맞춰 조정하세요. updater 종료 유예 90분은 이 전체 과정을 기다리기 위한 설정입니다.

## 사용 문서

| 문서 | 내용 |
|---|---|
| [YAML과 실행 정의](docs/service-sources.md) | docker run / Compose 가져오기, blue·green 개별 설정, 지원 옵션 |
| [동작 방식](docs/how-it-works.md) | 요청 전달, blue-green 전환, rollback 다이어그램 |
| [종료 설정](docs/graceful-shutdown.md) | Docker / REST 선택, 완료 확인, 대기 시간 |
| [게임 서버 연동](docs/game-integration.md) | 로비 배정과 기존 경기 유지 |
| [운영과 복구](docs/operations-guide.md) | updater 재시작, 슬롯 정리, 장애 복구 |

[테스트·기여 방법](CONTRIBUTING.md) · [보안 안내](SECURITY.md) · [기존 JSON 설정](docs/json-config.md) · [기존 환경변수 설정](docs/environment.md) · [MIT 라이선스](LICENSE)
