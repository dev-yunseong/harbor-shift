# Docker 및 REST 종료 설정

[빠른 시작으로 돌아가기](../README.md#빠른-시작)

기본 순서는 **새 슬롯 실행 → readiness 확인 → 신규 요청 전환 → 상태 관찰 → 기존 슬롯 drain → 완료 대기 → 종료**입니다. 기존 WebSocket을 새 컨테이너로 옮기지는 않습니다.

종료 방식은 환경변수로 선택할 수 있습니다. 대기 시간은 고정 sleep이 아니라 **완료 여부를 반복 확인하는 최대 시간**입니다. 빨리 끝나면 곧바로 다음 단계로 진행합니다.

| 설정 | 동작 |
|---|---|
| `HARBOR_SHUTDOWN_MODE=docker` | 기존 프록시 요청과 WebSocket이 끝나기를 기다린 뒤 Docker로 SIGTERM을 보냅니다. |
| `HARBOR_SHUTDOWN_MODE=http` | REST API로 graceful shutdown을 요청하고, 기본적으로 앱 프로세스가 스스로 종료할 때까지 기다립니다. |
| `HARBOR_DRAIN_MS=3600000` | 작업 완료 또는 프로세스 종료를 최대 1시간 기다립니다. |
| `HARBOR_STOP_SECONDS=120` | Docker 종료 시 SIGTERM 이후 최대 2분 기다린 뒤 SIGKILL을 보냅니다. |

위 값은 기본 환경변수 설정에 적용됩니다. 앱이 SIGTERM을 처리하거나 REST 요청을 받아 실제로 작업을 마무리하도록 구현되어 있어야 합니다.

REST 방식은 Compose의 `environment`를 다음처럼 설정합니다. `docker run`에서는 같은 값을 `-e 이름=값`으로 전달하세요.

```yaml
HARBOR_SHUTDOWN_MODE: http
HARBOR_HTTP_PATH: /admin/shutdown
HARBOR_HTTP_METHOD: POST
HARBOR_COMPLETION: exit
HARBOR_DRAIN_MS: "3600000"
HARBOR_STOP_SECONDS: "120"
```

위 API는 요청을 받은 뒤 2xx로 응답하고, 기존 작업을 마친 뒤 프로세스를 종료하는 앱을 가정합니다. **2xx 응답만으로 종료 완료로 판단하지 않습니다.** API가 신규 작업만 막고 프로세스는 계속 실행한다면 다음처럼 상태 API로 완료를 확인하세요.

```yaml
HARBOR_SHUTDOWN_MODE: http
HARBOR_HTTP_PATH: /admin/drain
HARBOR_COMPLETION: http
HARBOR_HTTP_STATUS_PATH: /admin/status
```

상태 API는 `{"draining":true,"sessions":0}` 형태로 응답해야 합니다. 앱 작업 수와 기존 프록시 연결 수가 모두 0일 때 SIGTERM을 보냅니다. 관리 API가 별도 포트에 있다면 `HARBOR_HTTP_URL: "http://{slot}:9090"`을 추가하세요. Authorization이 필요하면 updater의 `HARBOR_HTTP_AUTHORIZATION`에 전체 헤더 값(`Bearer ...`)을 비밀 환경변수로 주입하세요. 값은 설정 파일이나 저장소에 적지 마세요.

REST 요청 실패 시 기본 `HARBOR_ON_FAILURE=keep-old`는 기존 컨테이너를 보존하고 업데이트를 멈춥니다. 정상 요청 후 완료 대기 시간이 초과되면 Docker 종료로 넘어가므로, 경기나 작업의 실제 최대 시간에 맞게 늘리세요. Docker 방식의 연결 수만으로는 백그라운드 작업 완료를 알 수 없습니다. 이런 앱은 REST 상태 확인을 쓰거나 SIGTERM 이후 충분한 유예 시간을 설정해야 합니다.

updater 자체가 먼저 강제 종료되지 않도록 예제는 `--stop-timeout 5400` / `stop_grace_period: 90m`을 사용합니다. 이 값은 앱의 2분 종료 유예와 다른 설정입니다. 작업 대기 시간을 늘리면 updater의 종료 유예도 전체 배포 시간을 감당하도록 늘려야 합니다.

[전체 환경변수](environment.md) · [JSON hook 고급 설정](json-config.md#json-hook-설정) · [실패 복구](operations.md)
