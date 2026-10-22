# YAML과 앱 실행 정의

[빠른 시작](../README.md#빠른-시작)

`harbor.yml`은 Harbor Shift의 배포·종료 정책을 담습니다. 대상 앱의 이미지, 환경변수, 실행 명령은 `source`의 docker run 명령이나 Compose 서비스에서 가져옵니다. 이 명령이나 Compose 서비스를 따로 실행할 필요는 없습니다.

## 두 슬롯이 같은 실행 정의 사용

```yaml
group: web
network: harbor-demo
source:
  dockerRun: >-
    docker run --network harbor-demo --memory 256m --cpus 1
    --env-file app.env -p 8080:8080 example.invalid/team/web:stable
readinessPath: /health/ready
shutdown:
  mode: docker
timing:
  drainMs: 3600000
  stopSeconds: 120
```

이미지 주소는 실제 앱으로 바꾸세요. `dockerRun`은 문자열 또는 argv 배열을 받습니다. shell, 변수 치환, 파이프, 명령 연결을 실행하지 않습니다. 따옴표와 줄바꿈은 지원하며 `$(...)`, backtick, `&&`, redirect는 거부합니다. 앱 환경변수 파일 경로는 `harbor.yml` 기준이고 updater 내부에서 읽을 수 있어야 합니다.

## blue와 green에 다른 실행 정의 사용

각 슬롯의 `source`를 따로 적습니다. 두 개의 docker run 명령, 두 개의 Compose 파일, 또는 두 방식을 섞어서 사용할 수 있습니다.

```yaml
group: web
network: harbor-demo
slots:
  blue:
    source:
      dockerRun: >-
        docker run --network harbor-demo --memory 256m --cpus 1
        -e SLOT=blue -p 8080:8080 example.invalid/team/web:stable
  green:
    source:
      composeFile: ./green.compose.yml
      service: web
readinessPath: /health/ready
shutdown:
  mode: docker
```

`green.compose.yml` 예시:

```yaml
services:
  web:
    image: example.invalid/team/web:stable
    environment:
      SLOT: green
      PORT: "8081"
    ports: ["8081"]
    mem_limit: 256m
    cpus: 1
    networks: [app]
networks:
  app:
    external: true
    name: harbor-demo
```

앱이 실제로 `PORT` 환경변수를 읽어 수신 포트를 바꾸도록 구현되어 있어야 합니다. 두 슬롯은 환경변수·내부 포트·실행 명령·자원 제한을 다르게 지정할 수 있습니다. 자동 업데이트 시 반복 전환을 피하기 위해 **이미지 참조와 bridge network는 같아야 합니다.** `source`와 `slots`를 동시에 지정할 수는 없습니다.

두 Compose 파일을 사용할 때는 위 `slots` 부분을 다음처럼 바꾸세요.

```yaml
slots:
  blue:
    source:
      composeFile: ./blue.compose.yml
      service: web
  green:
    source:
      composeFile: ./green.compose.yml
      service: web
```

Compose 경로는 `harbor.yml` 기준입니다. 여러 서비스가 있으면 `service`가 필수입니다. Harbor Shift는 선택한 서비스만 읽고 `compose up`을 실행하지 않습니다. DB 등 다른 서비스는 별도로 실행해야 합니다. 앱 서비스와 updater 서비스가 들어 있는 Compose 파일은 서로 다른 역할이며, updater 자체를 앱으로 지정하면 안 됩니다.

## 설정과 경로 처리

| 필드 | 기본값 / 동작 |
|---|---|
| `group` | 필수. 실제 컨테이너 이름은 `<group>-blue/green`입니다. |
| `network` | 원본에서 추론 가능하면 생략할 수 있습니다. 두 슬롯과 updater가 같은 기존 bridge network에 있어야 합니다. |
| `appPort` | 원본 TCP 대상 포트가 하나면 추론합니다. 여러 포트이거나 포트가 없으면 직접 지정하세요. `slots.blue.appPort`처럼 슬롯별 지정도 가능합니다. |
| `listenPort` | 프록시 내부 포트, 기본 8080입니다. updater의 호스트 포트 매핑도 맞추세요. |
| `readinessPath` / `readinessStatus` | 기본 `/` / `200`. 두 슬롯에 같은 경로와 상태 코드를 사용합니다. |
| `stateDir` | 기본 `/state`. 전용 영속 volume으로 보존하세요. |
| `timing.drainMs` | 기본 3600000ms. 기존 작업 완료를 기다릴 최대 시간입니다. |
| `timing.stopSeconds` | 기본 120초. SIGTERM 이후 SIGKILL까지 기다립니다. |
| `timing.commandMs` | 기본 `max(120000, stopSeconds × 1000 + 30000)`입니다. 종료 유예보다 길어야 합니다. |
| `timing.watchMs` | 기본 60000ms. 이미지 확인 주기입니다. |
| `shutdown.mode` | 기본 `docker`. REST 종료는 [종료 설정](graceful-shutdown.md)을 참고하세요. |

Compose는 이미지에 포함된 Docker Compose plugin의 `config --format json`으로 정규화합니다. 이때 `.env`, `env_file`, 변수 치환은 Compose 규칙을 따릅니다. 필요한 파일을 updater에 read-only mount하세요. 정규화 결과에 포함된 앱 비밀값은 로그나 dry-run 출력에 표시하지 않습니다.

앱 bind mount의 source는 **Docker 호스트의 절대 경로**여야 합니다. Compose의 상대 bind 경로는 updater 내부 경로로 바뀌므로, 호스트에서도 동일하게 존재하는 경로를 사용하세요. `--env-file`은 Docker CLI가 읽지만 bind mount는 Docker daemon이 읽는다는 차이가 있습니다.

## 가져오는 옵션과 관리되는 값

- docker run: 이미지, 명령 인자, `--env`, `--env-file`, `--memory`, `--cpus`, `--entrypoint`, `--user`, `--workdir`, `--read-only`, `--init`, `--interactive`, 일반 label, read-only bind mount를 반영합니다. 짧은 옵션은 `-e`, `-p`, `-m`, `-u`, `-w`, `-v`, `-l`, `-d`, `-i`를 각각 분리해서 사용하세요.
- Compose: `image`, `command`, `entrypoint`, `environment`, `env_file`, `user`, `working_dir`, `read_only`, `init`, `stdin_open`, `mem_limit`, `cpus`, 일반 label, read-only bind mount를 반영합니다.
- `ports` / `expose`는 앱 내부 TCP 포트 추론에만 씁니다. 원래 호스트 포트는 복제하지 않으며 실제 접속은 updater 프록시를 통해 받습니다.
- 컨테이너 이름, `restart=no`, SIGTERM, 소유권 label은 Harbor Shift가 정합니다. 원본의 name/restart/detach/rm은 이 정책으로 대체합니다. 자원 제한이 없으면 슬롯당 256m / 1 CPU를 사용합니다.
- Compose `build`, `depends_on`, `healthcheck`, 특권 모드, host network, 여러 network, 공유 쓰기 volume, TTY와 나머지 미지원 옵션은 오류로 처리합니다. 이미지를 먼저 빌드·게시하고, 준비 상태는 Harbor Shift의 readiness 설정으로 지정하세요.

실행 중인 원본 컨테이너를 인계하거나 삭제하지 않습니다. 최초 도입은 새 슬롯을 생성하며, 기존 서비스에서의 트래픽 이관은 별도로 해야 합니다. 설정은 시작 시 읽으므로 원본 파일 변경을 자동으로 재배포하지 않습니다. 같은 이미지로 설정만 바꾸는 경우 기존 슬롯·상태와의 호환성을 확인하고 [운영 절차](operations.md)에 따라 처리하세요.

## 설정 검증

```sh
docker run --rm \
  --mount "type=bind,src=$(pwd),dst=/config,readonly" \
  ghcr.io/dev-yunseong/harbor-shift:latest /config/harbor.yml
```

`--apply`가 없으면 컨테이너 생성·이미지 pull·트래픽 전환을 하지 않습니다. Compose source는 로컬 설정을 정규화하기 위해 CLI를 호출하지만 `up`, `create`, `start`를 실행하지 않습니다. 설정 검증만으로 실제 네트워크·이미지·readiness를 검증한 것은 아닙니다.

기존 [JSON 설정](json-config.md)과 [환경변수 모드](environment.md)는 명시적으로 선택할 때만 사용하며 YAML과 값을 합치지 않습니다.
