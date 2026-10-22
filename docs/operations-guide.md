# 운영 전 확인 사항

[빠른 시작으로 돌아가기](../README.md#빠른-시작)

- 기본 프록시는 stateless HTTP/1.1과 WebSocket 서비스용입니다. TLS 종료, 임의 TCP/UDP, 공유 쓰기 볼륨, 기존 Compose 컨테이너 자동 인계는 지원하지 않습니다.
- 앱 배포와 달리 updater 자체를 재시작하면 프록시 연결이 끊깁니다. 무중단이나 proxy HA를 보장하지 않습니다.
- 배포 실패 시 `updates_paused` 로그와 journal을 확인하세요. 상태를 삭제하거나 무조건 재시작하지 마세요. [복구 절차](operations.md)
- `docker compose down`만으로 동적으로 만든 앱 슬롯이 삭제되지는 않습니다. 트래픽을 멈추고 해당 group의 슬롯을 확인한 뒤 정리해야 합니다. [종료 절차](proxy.md#stop-and-recovery)
- 두 버전이 동시에 실행되는 동안 DB 스키마가 호환되어야 합니다. DB migration과 백그라운드 작업 조정은 앱의 책임입니다.
- Docker socket 접근 권한은 호스트 root 권한에 준합니다. updater를 비공개로 유지하고 신뢰하는 이미지만 실행하세요. [보안 안내](../SECURITY.md)

Linux/Windows 단위 테스트와 격리된 실제 Docker 환경의 HTTP/WebSocket 배포 테스트를 수행했습니다. 비공개 registry 인증과 운영 앱 호환성은 별도로 검증해야 합니다. [검증 범위](operations.md#validation-status)

[실패 복구 절차](operations.md) · [보안 안내](../SECURITY.md) · [테스트·기여 방법](../CONTRIBUTING.md)
