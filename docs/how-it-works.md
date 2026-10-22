# Blue-green 동작 방식

[빠른 시작으로 돌아가기](../README.md#빠른-시작)

아래는 blue에서 green으로 전환한 직후의 연결 상태입니다. 새 HTTP 요청과 새 WebSocket 연결은 green으로 보내고, 전환 전에 시작한 요청과 WebSocket 연결은 blue에서 유지합니다. 다음 배포에서는 두 슬롯의 역할이 바뀝니다.

```mermaid
flowchart LR
    New["새 HTTP 요청 / 새 WebSocket 연결"] --> Proxy["Harbor Shift 프록시"]
    Existing["전환 전 요청 / 기존 WebSocket 연결"] --> Proxy
    Proxy -->|"신규 요청 전달"| Green["green: 새 버전"]
    Proxy -.->|"이미 연결된 backend 유지"| Blue["blue: 기존 버전"]
```

HTTP keep-alive 연결을 재사용해도 다음 요청은 현재 활성 슬롯으로 보냅니다. 이미 수립된 WebSocket 연결은 종료될 때까지 같은 슬롯에 남습니다.

이미지 변경을 감지하면 다음 순서로 배포합니다. 아래는 기존 슬롯이 실행 중인 경우이며, 최초 실행에서는 blue를 시작하고 readiness를 확인한 뒤 프록시를 엽니다.

```mermaid
flowchart TD
    Poll["이미지 확인"] --> Changed{"이미지가 바뀌었나?"}
    Changed -->|"아니요"| Wait["다음 확인 주기까지 대기"]
    Changed -->|"예"| Start["비활성 슬롯에 새 버전 실행"]
    Start --> Ready{"readiness 통과?"}
    Ready -->|"실패"| Keep["새 슬롯 정지 / 기존 경로 유지"]
    Ready -->|"성공"| Switch["신규 요청 경로 전환 및 상태 관찰"]
    Switch --> Healthy{"전환과 상태 확인 성공?"}
    Healthy -->|"실패 또는 결과 불확실"| Rollback["기존 경로 복구 및 새 슬롯 drain 시도"]
    Healthy -->|"성공"| Drain["기존 슬롯 drain 시작"]
    Drain --> Complete["기존 작업 완료 또는 drain 제한 시간까지 대기"]
    Complete --> Stop["SIGTERM / 유예 시간 초과 시 SIGKILL"]
    Stop --> Wait
```

그림은 주요 전환 경로를 보여줍니다. 기본 `keep-old` 정책에서 drain 시작 요청이나 완료 확인이 실패하면 기존 프로세스와 journal을 보존합니다. 배포 실패 시 프록시 모드는 업데이트를 멈추고 현재 경로로 계속 서비스합니다. rollback도 실패할 수 있으며, 기존 슬롯의 drain이 시작된 뒤에는 자동 rollback하지 않습니다. [실패 처리와 복구](operations.md)

[종료 설정](graceful-shutdown.md) · [게임 서버 연동](game-integration.md)
