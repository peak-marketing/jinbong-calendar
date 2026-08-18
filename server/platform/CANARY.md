# 플랫폼 정산 provider-selective canary import

이 root 전용 명령은 플랫폼 preflight가 끝난 뒤 선택한 공급사 한 곳만 운영 원장에 적재합니다. KST 기준 이전 월을 먼저, 현재 월을 다음으로 직렬 처리합니다. 외부 HTTP route를 만들지 않으며 PM2 환경, 동기화 플래그, scheduler를 변경하지 않습니다.

실행 전에 DB 백업과 유지보수 창을 확인해야 합니다. 완료된 snapshot과 연결 상태는 append-only로 저장되며, 최신 연결 상태가 `ready`가 되는 즉시 월 정산 화면에서 보일 수 있습니다.

## 필수 조건

- 문서에 포함됐던 키가 아닌 재발급 키만 사용합니다.
- `PREFLIGHT.md`의 root 소유·`0600`·일반 파일·no-symlink 시크릿 파일을 사용합니다.
- 파일에는 리워드스페이스, 리뷰스페이스, 키워드마스터 세 키가 모두 있어야 합니다. 전체 세 키를 configured set으로 유지하므로 선택하지 않은 공급사를 `disabled`로 바꾸지 않습니다.
- 런타임 DB 역할은 안전한 append-only 권한을 가진 `calendar_user`여야 합니다. CLI는 적재 전에 전체 플랫폼 infrastructure readiness를 검사합니다.

## 실행

서버 디렉터리에서 공급사를 한 곳씩 실행합니다.

```text
npm run platform:canary -- --provider rewardspace --env-file /root/.peakos-secrets/platform-api.env --confirm IMPORT_PLATFORM_CURRENT_PREVIOUS
npm run platform:canary -- --provider keywordmaster --env-file /root/.peakos-secrets/platform-api.env --confirm IMPORT_PLATFORM_CURRENT_PREVIOUS
npm run platform:canary -- --provider reviewspace --env-file /root/.peakos-secrets/platform-api.env --confirm IMPORT_PLATFORM_CURRENT_PREVIOUS
```

출력은 공급사와 월, 성공 여부, 원본·제외·워크스페이스·중복·귀속 문제 건수, 안전한 오류 코드만 포함합니다. API 키, 응답 원문, 영업자명, 금액, 워크스페이스 ID는 출력하지 않습니다. 두 월 모두 성공하고 미귀속·동명이인·귀속 문제 건수가 0일 때만 종료 코드 0을 반환합니다.

이 명령은 실제 운영 DB에 append하므로 preflight와 다릅니다. 실패 시 delete/update하지 말고 해당 공급사의 키를 운영 활성화 대상에서 제외한 뒤 append-only `disabled` 상태와 필요한 snapshot quarantine 절차를 사용합니다.
