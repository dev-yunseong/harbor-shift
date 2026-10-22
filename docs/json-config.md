# 기존 JSON 설정

[빠른 시작으로 돌아가기](../README.md#빠른-시작)

기본 사용 방법은 [YAML과 실행 정의](service-sources.md)입니다. 이 문서는 exec/stdin hook이나 기존 JSON 설정을 유지할 때 참고하세요. 환경변수 모드와 JSON 모드는 서로 값을 덮어쓰지 않습니다. JSON 모드의 기본 drain 대기는 5분, SIGTERM 유예는 30초이며 환경변수 모드의 1시간 / 2분과 다릅니다.


복잡한 hook이나 기존 설정을 유지하려면 아래 내용을 `service.json`으로 저장해서 사용할 수 있습니다. 예제를 이미 실행했다면 기존 슬롯과 상태를 먼저 정리해야 합니다. [종료와 복구 절차](proxy.md#stop-and-recovery)를 참고하세요.

아래 `image`는 설명용 주소입니다. 실제로 pull할 수 있는 이미지로 바꿔야 합니다.

```json
{
  "enabled": true,
  "group": "my-web",
  "image": "example.invalid/team/web:stable",
  "network": "harbor-demo",
  "stateDir": "/state",
  "appPort": 8080,
  "listenPort": 8080,
  "readinessPath": "/health/ready",
  "readinessStatus": 200,
  "memory": "256m",
  "cpus": 1,
  "timing": { "watchMs": 60000, "drainMs": 300000, "stopSeconds": 30 }
}
```

| 설정 | 의미와 확인할 점 |
|---|---|
| `group` | 서비스 고유 이름입니다. `my-web-blue`, `my-web-green` 컨테이너를 생성합니다. |
| `image` | 변경을 감시할 이미지 태그입니다. 해당 태그에 새 이미지를 push하면 다음 확인 주기에 배포합니다. |
| `network` | updater와 앱이 함께 접속할 Docker bridge network입니다. 기본 Compose가 `harbor-demo`를 만듭니다. |
| `stateDir` | 경로와 배포 진행 상태를 저장합니다. 기본 Compose는 `/state`를 전용 named volume에 보존합니다. |
| `appPort` | 앱이 컨테이너 내부에서 수신하는 포트입니다. 호스트에 직접 공개하지 않습니다. |
| `listenPort` | updater 프록시의 내부 포트입니다. 바꾸면 Compose의 포트 매핑도 맞춰야 합니다. |
| `readinessPath` | 새 앱이 요청을 받을 준비가 됐는지 확인할 경로입니다. 지정한 HTTP 상태 코드와 정확히 일치해야 하며 redirect는 실패합니다. |
| `memory`, `cpus` | 각 앱 슬롯의 자원 제한입니다. 전환 중에는 두 슬롯이 동시에 실행됩니다. |
| `watchMs` | 이미지 확인 간격입니다. 예시는 60초입니다. |
| `drainMs` | 기존 작업 종료를 기다릴 최대 시간입니다. 예시는 5분입니다. |
| `stopSeconds` | 종료 시 SIGTERM 이후 SIGKILL까지의 유예 시간입니다. 예시는 30초입니다. |

파일을 `/config/service.json`으로 read-only mount하고 실행 인자를 `/config/service.json --apply`로 지정하세요. Compose에서는 `command: ["/config/service.json", "--apply"]`로 바꿉니다. 이 모드에서는 `HARBOR_*` 설정을 읽지 않습니다. 이후에는 같은 이미지 태그를 갱신하면 updater가 변경을 감지합니다. 설정 파일의 실시간 재로딩은 지원하지 않습니다.

앱 환경변수는 `envFile`로 지정할 수 있습니다. 해당 파일은 updater 내부에서 읽을 수 있도록 별도로 read-only mount해야 합니다. 비공개 registry는 전용 Docker CLI 인증 설정을 read-only mount하는 등 별도의 인증 구성이 필요합니다. 비밀값은 JSON이나 저장소에 넣지 마세요. [전체 설정 설명](proxy.md)

앱 컨테이너를 변경하지 않고 설정만 검사하려면 `--apply` 없이 실행하세요. 이 검사는 실제 이미지 접근이나 서비스 동작을 검증하지 않습니다. Docker socket이나 상태 volume을 연결할 필요도 없습니다.

```sh
docker run --rm \
  --mount "type=bind,src=$(pwd)/service.json,dst=/config/service.json,readonly" \
  ghcr.io/dev-yunseong/harbor-shift:latest /config/service.json
```

CLI는 `--apply`가 없으면 실행 계획만 출력합니다. 제공된 Compose 파일에는 `--apply`가 지정되어 있어 실제 배포가 실행됩니다.

## JSON hook 설정


종료 hook이 없으면 프록시가 기존 HTTP 요청과 WebSocket 연결이 끝나기를 기다린 뒤 SIGTERM을 보냅니다. 앱이 신규 작업 수신을 중단하거나 별도의 정리를 해야 한다면 `service.json`에 `shutdown`을 추가하세요.

예를 들어 이미지에 `/app/drain` 실행 파일이 있고, 이 파일이 신규 작업만 중단하도록 구현되어 있다면 다음과 같이 설정합니다.

```json
"shutdown": {
  "initiate": { "type": "exec", "argv": ["/app/drain"], "timeoutMs": 5000 },
  "completion": { "type": "proxy" },
  "onFailure": "keep-old"
}
```

이 항목은 전체 JSON이 아니라 기존 설정 객체에 추가하는 필드입니다. `/app/drain`은 Harbor Shift가 제공하는 명령이 아니라 앱에서 구현해야 하는 예시입니다.

- 시작 방법은 컨테이너 내부 명령(`exec`), HTTP 요청, 앱 원래 프로세스의 stdin 중에서 고를 수 있습니다.
- `completion: proxy`는 요청과 연결 수만 확인합니다. 백그라운드 작업이나 접속자가 없는 게임도 기다려야 한다면 HTTP 상태 hook 또는 프로세스 종료 대기를 사용하세요.
- 기본 `keep-old` 정책은 drain 시작 요청이 실패하면 기존 프로세스와 journal을 보존하고 배포를 멈춥니다. 이미 전환한 신규 요청은 새 슬롯으로 계속 보냅니다.
- drain이 시작된 뒤 제한 시간을 넘으면 종료를 진행하므로 연결이나 작업이 끊길 수 있습니다. drain 시작 후에는 기존 슬롯으로 자동 rollback하지 않습니다.

[HTTP·stdin 예시와 완료 조건](shutdown.md)

[환경변수 설정](environment.md) · [종료 hook 상세 계약](shutdown.md)
