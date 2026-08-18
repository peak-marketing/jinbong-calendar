# 플랫폼 API 운영자 preflight

이 명령은 재발급된 플랫폼 API 키를 PM2 환경이나 운영 동기화에 넣기 전에 계약을 확인하는 root 전용 도구입니다. 운영 DB를 읽거나 쓰지 않으며 PM2와 프로세스 환경도 변경하지 않습니다. 지정한 월의 공급사 읽기 전용 API를 공급사당 정확히 한 번 호출하고, 기존 플랫폼 커넥터의 고정 URL·응답 스키마·합계 검증을 그대로 사용합니다.

## 시크릿 파일

절대 경로의 일반 파일만 허용합니다. 파일과 경로에 심볼릭 링크가 없어야 하고, 소유자는 root, 권한은 정확히 `0600`이어야 합니다. 빈 파일, 빈 값, 중복 키, 알 수 없는 키는 호출 전에 거부합니다.

허용되는 이름은 아래 세 개뿐입니다.

```text
PEAKOS_REWARDSPACE_API_KEY=<rotated secret>
PEAKOS_REVIEWSPACE_API_KEY=<rotated secret>
PEAKOS_KEYWORDMASTER_API_KEY=<rotated secret>
```

단일 공급사 검증 파일에는 선택한 공급사의 키만 있어도 됩니다. `--all`에는 세 키가 모두 필요합니다. 문서에 포함됐던 기존 키는 사용하지 않습니다.

## 실행

서버 디렉터리에서 단일 공급사를 먼저 검증합니다.

```text
npm run platform:preflight -- --provider rewardspace --month 2026-08 --env-file /root/.peakos-secrets/platform-api.env
npm run platform:preflight -- --provider reviewspace --month 2026-08 --env-file /root/.peakos-secrets/platform-api.env
npm run platform:preflight -- --provider keywordmaster --month 2026-08 --env-file /root/.peakos-secrets/platform-api.env
```

세 공급사를 한 명령으로 검사할 때도 호출은 리워드스페이스, 리뷰스페이스, 키워드마스터 순서로 직렬 실행됩니다.

```text
npm run platform:preflight -- --all --month 2026-08 --env-file /root/.peakos-secrets/platform-api.env
```

성공 출력은 공급사 식별자, 성공 여부, 원문 상태, 유효 행 수, 제외 행 수만 포함합니다. 실패 출력은 안전한 오류 코드만 포함합니다. API 키, 원문 응답, 영업자명, 금액은 stdout 또는 stderr에 출력하지 않습니다. 종료 코드가 0인 경우에만 검증 성공이며, 이 명령 자체는 동기화 활성화나 운영 원장 적재를 수행하지 않습니다.
