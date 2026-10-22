# Docker 및 REST 종료 설정

[빠른 시작](../README.md#빠른-시작) · [YAML 설정](service-sources.md)

`harbor.yml`의 `shutdown`과 `timing`에서 종료 방식을 정합니다. 공통 source와 슬롯별 source 모두 같은 종료 정책을 사용합니다.

## Docker로 종료

```yaml
shutdown:
  mode: docker
timing:
  drainMs: 3600000
  stopSeconds: 120
```

신규 요청을 새 슬롯으로 전환하고, 기존 HTTP 요청과 WebSocket이 끝나기를 최대 1시간 기다립니다. 작업이 일찍 끝나면 바로 SIGTERM을 보냅니다. SIGTERM 이후 최대 2분 안에 종료되지 않으면 Docker가 SIGKILL을 보냅니다.

이 값은 YAML source 모드의 기본값이며, 실제 작업 시간에 맞게 바꾸세요. 앱이 SIGTERM을 처리해 진행 중인 작업을 마무리하도록 구현되어 있어야 합니다. 프록시 연결 수만으로 백그라운드 작업 완료를 알 수 없으므로, 그런 앱은 REST 상태 API 또는 충분한 SIGTERM 유예 시간을 사용하세요.

## REST API로 종료 요청

```yaml
shutdown:
  mode: http
  request:
    method: POST
    path: /admin/shutdown
    timeoutMs: 10000
  completion:
    type: exit
  onFailure: keep-old
timing:
  drainMs: 3600000
  stopSeconds: 120
```

API가 요청을 받으면 2xx로 응답하고, 기존 작업을 끝낸 뒤 프로세스를 종료하는 앱을 가정합니다. **2xx 응답은 요청 접수이며 종료 완료가 아닙니다.** Harbor Shift는 실제 프로세스 종료까지 기다립니다. `completion`을 생략해도 HTTP 모드에서는 `exit`가 기본입니다.

## 상태 API로 작업 완료 확인

API가 새 작업만 막고 프로세스는 계속 실행한다면 다음처럼 설정하세요.

```yaml
shutdown:
  mode: http
  request:
    path: /admin/drain
  completion:
    type: http
    path: /admin/status
    timeoutMs: 2000
```

종료 요청은 기본 POST, 응답 제한은 10초입니다. 상태 API는 GET이며 `{"draining":true,"sessions":0}` 형태로 응답해야 합니다. 전체 앱 작업 수와 기존 프록시 연결 수가 모두 0일 때 SIGTERM을 보냅니다. 단순 연결 수에 잡히지 않는 백그라운드 작업도 `sessions`에 포함해야 합니다.

## 별도 관리 포트와 인증

```yaml
shutdown:
  mode: http
  request:
    url: http://{slot}:9090
    path: /admin/drain
    headersEnv:
      Authorization: APP_DRAIN_AUTH
  completion:
    type: http
    url: http://{slot}:9090
    path: /admin/status
    timeoutMs: 2000
    headersEnv:
      Authorization: APP_DRAIN_AUTH
```

`{slot}`은 실제 blue 또는 green 컨테이너 이름으로 치환됩니다. URL을 생략하면 각 슬롯의 앱 URL을 사용합니다. `APP_DRAIN_AUTH`는 updater에 비밀 환경변수로 주입하며 값에는 `Bearer ...`처럼 전체 헤더를 넣으세요. YAML이나 저장소에 실제 비밀값을 적지 마세요. `request.body`로 JSON 호환 객체를 전달할 수도 있습니다.

## 실패와 대기 시간

- 기본 `onFailure: keep-old`는 종료 요청 실패 시 기존 프로세스와 journal을 보존하고 업데이트를 멈춥니다. 신규 요청은 이미 전환한 슬롯으로 계속 보냅니다.
- 명시적 `force-stop`은 종료 요청 실패 후 완료 대기를 건너뜁니다. 작업이 끊길 수 있으므로 기본으로 쓰지 마세요.
- 정상 종료 요청 이후에도 `drainMs`를 넘으면 Docker 종료로 넘어갑니다. 시간 제한은 완료 보장이 아니며, 실제 경기·작업 길이에 맞게 설정해야 합니다.
- `timing.commandMs`는 `stopSeconds`보다 길게 자동 계산됩니다. 직접 지정한다면 종료 유예보다 길어야 합니다.
- updater 자체의 `--stop-timeout` / `stop_grace_period`는 readiness·작업 대기·종료 유예 등 전체 배포 시간을 감당해야 합니다. 빠른 시작의 90분은 기본 설정 예시이며 작업 대기를 늘리면 함께 늘리세요.

exec/stdin hook은 기존 `shutdown.initiate` 형식을 YAML에서도 사용할 수 있습니다. `mode` 형식과 동시에 섞지 마세요. [hook 상세 계약](shutdown.md) · [실패 복구](operations.md)
