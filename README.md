<div align="center">

# Harbor Shift

HTTP/WebSocket 서비스를 위한 Docker blue-green 배포 도구입니다.

[빠른 시작](#빠른-시작) · [사용 문서](#사용-문서)

</div>

Harbor Shift는 설정한 이미지 태그를 주기적으로 확인하고, 이미지가 바뀌면 새 컨테이너를 실행합니다. 준비 상태를 확인한 뒤 신규 요청을 새 컨테이너로 보내고, 기존 요청과 WebSocket 연결은 원래 컨테이너에서 마치도록 기다립니다.

기본 모드는 프록시를 포함하므로 별도의 배포 controller를 구현할 필요가 없습니다. updater 하나가 서비스 하나의 blue/green 슬롯을 관리합니다.

## 빠른 시작

Linux Docker Engine (`linux/amd64`)이 필요합니다. GHCR 이미지를 받아 `docker run` 또는 Docker Compose의 환경변수로 설정합니다. Docker Compose를 사용할 경우 Compose plugin도 설치하세요.

`main`에 push하면 CI 테스트를 통과한 뒤 `ghcr.io/dev-yunseong/harbor-shift`에 `latest`와 `sha-<전체 commit SHA>` 태그를 게시합니다. 운영에서는 검증한 SHA 태그 또는 digest로 고정할 수 있습니다. [CI](https://github.com/dev-yunseong/harbor-shift/actions/workflows/test.yml)의 게시 완료를 확인하세요. private 패키지는 읽기 권한으로 로그인해야 하며, 익명 pull을 제공하려면 관리자가 패키지를 public으로 설정해야 합니다.

아래 두 방법 중 하나만 선택하세요. 같은 서비스에 updater를 두 개 실행하면 안 됩니다. 예제 앱은 `traefik/whoami:v1.11`이며, 명령은 Linux shell 기준입니다.

### docker run으로 실행하기

처음 한 번 네트워크와 상태 저장 volume을 만드세요. 이미 같은 이름의 리소스가 있으면 용도를 확인한 뒤 재사용하세요.

```sh
docker network create harbor-demo
docker volume create harbor-state
docker pull ghcr.io/dev-yunseong/harbor-shift:latest

docker run -d \
  --name harbor-shift \
  --network harbor-demo \
  --restart=no \
  --stop-timeout 5400 \
  -p 127.0.0.1:8080:8080 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=volume,src=harbor-state,dst=/state \
  -e HARBOR_ENABLED=true \
  -e HARBOR_GROUP=harbor-web \
  -e HARBOR_IMAGE=traefik/whoami:v1.11 \
  -e HARBOR_NETWORK=harbor-demo \
  -e HARBOR_APP_PORT=80 \
  -e HARBOR_READINESS_PATH=/ \
  -e HARBOR_SHUTDOWN_MODE=docker \
  -e HARBOR_DRAIN_MS=3600000 \
  -e HARBOR_STOP_SECONDS=120 \
  ghcr.io/dev-yunseong/harbor-shift:latest --env --apply

docker logs -f harbor-shift
```

### Docker Compose로 실행하기

아래 내용을 `compose.yaml`로 저장하세요. Compose가 네트워크와 상태 저장 volume을 생성합니다.

```yaml
services:
  harbor-shift:
    image: ghcr.io/dev-yunseong/harbor-shift:latest
    command: ["--env", "--apply"]
    environment:
      HARBOR_ENABLED: "true"
      HARBOR_GROUP: harbor-web
      HARBOR_IMAGE: traefik/whoami:v1.11
      HARBOR_NETWORK: harbor-demo
      HARBOR_APP_PORT: "80"
      HARBOR_READINESS_PATH: /
      HARBOR_SHUTDOWN_MODE: docker
      HARBOR_DRAIN_MS: "3600000"
      HARBOR_STOP_SECONDS: "120"
    ports: ["127.0.0.1:8080:8080"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
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
docker compose logs -f harbor-shift
```

### 접속 확인과 내 서비스 설정

다른 터미널에서 `curl http://localhost:8080`을 실행하세요. 앱 컨테이너 정보가 나오면 프록시를 통해 접속한 것입니다. 외부에 서비스하려면 앞단에 TLS를 처리하는 reverse proxy를 두세요.

실제 서비스는 처음 실행하기 전에 `HARBOR_IMAGE`, `HARBOR_APP_PORT`, `HARBOR_READINESS_PATH`를 바꾸면 됩니다. 대상 앱의 환경변수는 `HARBOR_APP_ENV_FILE`에 updater 내부의 파일 경로를 지정하고 그 파일을 read-only mount해서 전달할 수 있습니다. updater 환경변수 전체를 앱에 복사하지 않습니다.

위 명령의 이미지 인자는 Harbor Shift 자체이고, `HARBOR_IMAGE`는 교체할 앱 이미지입니다. updater가 앱 슬롯을 생성하므로 같은 앱을 별도 Compose 서비스나 Watchtower로 함께 관리하지 마세요. 임의의 `docker run` 문자열이나 기존 Compose 서비스를 자동으로 가져오는 기능은 아닙니다.

`--env`로 환경변수 설정을 사용합니다. `--apply`를 빼면 설정 검증만 수행합니다. [전체 환경변수](docs/environment.md)

## 사용 문서

| 문서 | 내용 |
|---|---|
| [환경변수 설정](docs/environment.md) | 대상 이미지, 포트, 자원 제한, 앱 환경변수와 대기 시간 |
| [동작 방식](docs/how-it-works.md) | 요청 전달, blue-green 전환, rollback Mermaid 다이어그램 |
| [종료 설정](docs/graceful-shutdown.md) | Docker / REST 선택, 작업 완료 확인, graceful shutdown 대기 시간 |
| [게임 서버 연동](docs/game-integration.md) | 로비 배정과 기존 경기 유지, 연동 sequence diagram |
| [운영과 복구](docs/operations-guide.md) | updater 재시작, 슬롯 정리, DB 호환성과 실패 복구 |
| [JSON 고급 설정](docs/json-config.md) | 기존 JSON 설정 및 exec/stdin hook이 필요한 경우 |

[테스트·기여 방법](CONTRIBUTING.md) · [보안 안내](SECURITY.md) · [프로젝트 배경](docs/provenance.md) · [MIT 라이선스](LICENSE)
