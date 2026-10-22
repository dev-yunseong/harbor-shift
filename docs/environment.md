# 환경변수 설정

`node src/proxy-cli.js --env [--apply]` 또는 Docker 이미지의 `--env --apply` 인자로 사용합니다. `docker run -e`와 Compose `environment` 모두 같은 설정을 받습니다. JSON 파일 모드와 합쳐서 덮어쓰지 않으며, 알 수 없는 `HARBOR_*` 이름이나 잘못된 값은 컨테이너를 변경하기 전에 오류로 처리합니다. 인자를 생략한 이미지는 환경변수 모드의 dry-run입니다.

## 대상 앱과 프록시

| 변수 | 기본값 | 의미 |
|---|---|---|
| `HARBOR_ENABLED` | `false` | 반드시 `true`로 설정해서 관리에 동의합니다. |
| `HARBOR_GROUP` | 필수 | 관리할 슬롯 이름의 접두사입니다. 서비스마다 달라야 합니다. |
| `HARBOR_IMAGE` | 필수 | 교체할 앱 이미지 태그 또는 digest입니다. |
| `HARBOR_NETWORK` | 필수 | updater와 앱이 함께 사용할 기존 bridge network입니다. |
| `HARBOR_APP_PORT` | `8080` | 앱 컨테이너 내부 포트입니다. |
| `HARBOR_LISTEN_PORT` | `8080` | 프록시 내부 포트입니다. 호스트 매핑도 맞추세요. |
| `HARBOR_READINESS_PATH` | `/` | readiness 경로입니다. |
| `HARBOR_READINESS_STATUS` | `200` | 정확히 일치해야 하는 HTTP 상태 코드입니다. |
| `HARBOR_MEMORY` | `256m` | 앱 슬롯 하나의 메모리 제한입니다. |
| `HARBOR_CPUS` | `1` | 앱 슬롯 하나의 CPU 제한입니다. |
| `HARBOR_STATE_DIR` | `/state` | 전용 영속 volume에 저장할 경로입니다. |
| `HARBOR_DOCKER_CONTEXT` | `default` | updater 내부 Docker CLI context입니다. |
| `HARBOR_APP_ENV_FILE` | 없음 | 앱용 env 파일의 updater 내부 경로입니다. read-only mount하고 절대 경로를 권장합니다. |
| `HARBOR_PULL_POLICY` | `always` | `never`는 registry에 접근하지 않고 로컬 이미지로 비교합니다. |
| `HARBOR_PROXY_REQUEST_MS` | `DRAIN_MS` 이상, 최소 1000 | HTTP upstream 무응답 제한입니다. WebSocket 수명 제한은 아닙니다. |

`HARBOR_*` 값은 updater 설정이며 앱으로 자동 전달되지 않습니다. 앱의 command/entrypoint/user는 이미지 정의를 따릅니다. Compose 서비스 가져오기, 임의 Docker 옵션, 공유 볼륨은 지원하지 않습니다.

## 종료 방식

| 변수 | 기본값 | 의미 |
|---|---|---|
| `HARBOR_SHUTDOWN_MODE` | `docker` | `docker` 또는 `http`입니다. |
| `HARBOR_COMPLETION` | docker: `proxy`, http: `exit` | `proxy`: 연결 종료, `exit`: 프로세스 종료, `http`: 앱 상태와 프록시 연결을 함께 확인합니다. Docker 방식은 `proxy`만 허용합니다. |
| `HARBOR_ON_FAILURE` | `keep-old` | 종료 요청 실패 시 기존 프로세스를 유지합니다. 명시적 `force-stop`은 완료 대기를 건너뛰므로 작업이 끊길 수 있습니다. |
| `HARBOR_HTTP_PATH` | HTTP 모드 필수 | 종료 요청 경로입니다. 예: `/admin/shutdown`. |
| `HARBOR_HTTP_METHOD` | `POST` | `POST`, `PUT`, `PATCH`, `DELETE` 중 하나입니다. |
| `HARBOR_HTTP_URL` | 슬롯의 앱 URL | 별도 관리 포트를 사용할 때 지정합니다. `{slot}`은 컨테이너 이름으로 치환됩니다. 요청·상태 API 모두 같은 base URL을 사용합니다. |
| `HARBOR_HTTP_AUTHORIZATION` | 없음 | 전체 Authorization 헤더 값입니다. 비밀 환경변수로 주입하세요. |
| `HARBOR_HTTP_TIMEOUT_MS` | `10000` | 종료 요청 응답 대기 시간입니다. 작업 완료 대기 시간과 다릅니다. |
| `HARBOR_HTTP_STATUS_PATH` | HTTP 완료 모드 필수 | `GET` 상태 API 경로입니다. |
| `HARBOR_HTTP_STATUS_TIMEOUT_MS` | `2000` | 개별 상태 조회 응답 대기 시간입니다. |

HTTP 모드는 2xx 응답을 종료 요청 접수로 취급합니다. `exit`는 앱이 스스로 종료할 때까지 기다립니다. `http` 완료 응답은 `{"draining":true,"sessions":0}` 형태이며 모든 백그라운드 작업도 포함해야 합니다. 본문이나 커스텀 헤더가 필요한 API, exec/stdin hook은 [JSON 종료 설정](shutdown.md)을 사용하세요.

## 대기 시간

| 변수 | 기본값 | 의미 |
|---|---|---|
| `HARBOR_DRAIN_MS` | `3600000` (1시간) | 종료 요청이 접수된 뒤 작업 완료를 기다릴 최대 시간입니다. Docker 모드는 프록시에서 신규 요청을 차단한 뒤 대기합니다. |
| `HARBOR_STOP_SECONDS` | `120` (2분) | SIGTERM 이후 SIGKILL까지의 유예입니다. 최대 3600초입니다. |
| `HARBOR_COMMAND_MS` | `max(120000, STOP_SECONDS × 1000 + 30000)` | Docker 명령 제한 시간입니다. 종료 유예보다 길어야 합니다. |
| `HARBOR_WATCH_MS` | `60000` | 이미지 확인 간격입니다. |
| `HARBOR_READY_MS` | `60000` | 새 슬롯 readiness 대기 시간입니다. |
| `HARBOR_STABILIZE_MS` | `5000` | 전환 후 상태 관찰 시간입니다. |
| `HARBOR_POLL_MS` | `500` | readiness·작업 완료 확인 간격입니다. |
| `HARBOR_REQUEST_MS` | `2000` | 기본 API 요청 제한 시간입니다. |

시간은 `STOP_SECONDS`를 제외하고 밀리초입니다. 각 timing 값은 양의 정수이며 최대 86400000입니다. 작업이 일찍 끝나면 남은 시간을 기다리지 않고 종료합니다. 대기 한도 뒤에는 SIGTERM, 이어서 필요하면 SIGKILL로 종료하므로 완료를 무조건 보장하지 않습니다.

updater의 `--stop-timeout` 또는 Compose `stop_grace_period`는 앱 작업 대기, readiness, 상태 관찰, Docker 명령 및 종료 유예를 감당해야 합니다. README의 90분은 기본 설정 예시이며 값을 늘렸다면 함께 조정하세요. 기존 JSON 설정의 기본 대기 값은 호환성을 위해 변경하지 않았습니다.
