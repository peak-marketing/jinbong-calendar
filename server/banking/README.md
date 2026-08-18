# PEAK OS 통장 원장

현재 단계는 **조회 전용 원장**이다. 은행 거래를 저장·조회하지만 정산서, 충전금, 미수금을 자동으로 변경하지 않는다.

본사 매출, 공급처, 고정비용, 리뷰스페이스, 리워드스페이스 다섯 통장의 표시 정보가 등록되어 있다. 수집기와 스케줄러는 각각의 운영 플래그를 명시적으로 켜야만 동작한다.

## 안전 원칙

- 계좌번호·계좌 비밀번호·식별번호를 소스, DB, 감사 로그에 저장하지 않는다.
- 화면과 API에는 마스킹된 계좌번호만 노출한다.
- 은행 원문 응답을 저장하지 않고, 업무에 필요한 필드만 정규화한다.
- 입금자명 부분 일치나 금액 일치만으로 정산·충전을 자동 승인하지 않는다.
- 운영 환경의 조회 수집기는 웹 서버와 다른 OS 사용자·서비스로 분리하고, 이체 권한이 없는 전용 자격증명을 사용한다.
- 웹 서버와 자식 worker 모두 외부 JavaScript를 실행하지 않는다. `transkey.js`는 승인한 SHA-256과 일치한 바이트에서 RSA 인증서 선언 하나만 엄격히 파싱하고, 키패드 암호화는 자식 worker의 고정된 로컬 SEED-CBC 구현으로 수행한다.

## 현재 API

- `GET /api/peakos/bank/accounts`
- `GET /api/peakos/bank/transactions`
- `GET /api/peakos/bank/sync-runs`
- `PUT /api/peakos/bank/accounts/:accountId` — 마스킹된 표시 정보만 저장(초기 설정에서 관리 권한 차단)
- `POST /api/peakos/bank/accounts/:accountId/import` — 명시적 허용 전까지 기본 비활성화
- `POST /api/peakos/bank/accounts/:accountId/sync` — 수집기가 명시적으로 연결된 경우만 작동

계좌 목록 응답의 `connection`은 비밀값 없이 `HEALTHY`, `READY`,
`MANUAL_ONLY`, `WAITING_FIRST_SYNC`, `STALE`, `BLOCKED`, `DISABLED` 중 하나를
반환한다. 화면은 이 값을 사용해 단순한 “연결됨” 표시 대신 계좌 매핑, 첫
동기화, 30분 이상 갱신 지연, 최근 실패를 구분한다.

`PEAKOS_IBK_ENABLED`가 정확히 `true`가 아니면 수집기 팩토리가 `null`을 반환하고 동기화 API는 `BANK_COLLECTOR_NOT_CONFIGURED`로 거절된다. 파일 가져오기 기능인 `allowImport`도 `false`이다.

## IBK 빠른조회 worker 연결

`collectors/ibk-quick-collector.js`는 다섯 DB 통장 ID를 비밀파일의 각 계좌 키에 고정 매핑한다. 부모 프로세스만 `/root/.peakos-secrets/ibk-accounts.env`를 읽고, 선택한 계좌의 계좌번호·4자리 조회 비밀번호·공통 식별번호만 최소 환경변수로 자식 프로세스에 전달한다. 공용 loader는 상위 디렉터리 `0700`, 파일 `0600`, 실행 사용자 소유권, 일반 파일·비심볼릭 링크, exact 11-key 형식을 강제한다.

자식 프로세스는 다음 방어선 안에서 동작한다.

- `kiup.ibk.co.kr:443` 외 URL 및 타 호스트 리다이렉트 거절
- 공개 `transkey.js` 응답 body를 SHA-256 allowlist로 검증한 뒤 인증서 데이터만 파싱; 핀이 없거나 다르면 인증 거래 조회를 진행하지 않음
- `TranskeyLibPack_op.js`를 다운로드하거나 실행하지 않음. RFC 4269 공식 벡터와 동일 암호문 fixture로 검증한 순수 로컬 SEED-CBC 구현만 사용
- 자식 Node는 문자열 코드 생성과 `__proto__` 변경을 금지하고 메모리를 192 MiB로 제한
- 부모 실행 제한시간, stdout 4 MiB·stderr 64 KiB 제한 및 초과 시 강제 종료
- stdout은 정규화·마스킹한 거래 필드 하나의 JSON 문서만 허용; 원문 HTML/응답/자격정보/stack은 전달하지 않음
- stderr는 외부 로그로 전달하지 않고 메모리에서 민감값 마스킹 후 폐기
- 최대 조회기간 30일, 최대 거래 2,000건
- 응답 형식 오류는 고정 allowlist 코드로만 단계·필드 위치를 알리고, 원문·필드값·계좌정보는 출력하지 않음
- 전체 HTML 응답의 그리드 설정·조회조건 요약 행은 거래에서 제외하며, 금액의 소수 표기는 소수부가 모두 0일 때만 허용

이 모듈은 `server/index.js`의 서버 조립부에서 다음처럼 플래그로 연결한다. 수동 동기화와 자동 스케줄러는 별도 플래그이고 둘 다 기본값이 꺼짐이다.

```js
const { createIbkQuickCollector } = require('./banking/collectors/ibk-quick-collector');
const collector = createIbkQuickCollector({
  enabled: process.env.PEAKOS_IBK_ENABLED === 'true',
});
```

10분 자동동기화는 수집기가 켜져 있으면서 `PEAKOS_IBK_SCHEDULER_ENABLED=true`일 때만 시작된다. 따라서 핀이나 자격정보가 파일에 존재한다는 이유만으로 은행 요청이 발생하지 않는다.

## 추가 런타임 설정

현재 비밀파일은 정확히 11개 자격정보 키만 허용한다. 아래 핀은 웹 서버 런타임 환경변수로 별도 주입해야 한다. 쉼표로 구분한 여러 해시를 허용하므로 검토된 버전 교체 기간에만 구핀과 신핀을 함께 둘 수 있다.

```dotenv
PEAKOS_IBK_ENABLED=false
PEAKOS_IBK_SCHEDULER_ENABLED=false
PEAKOS_IBK_TRANSKEY_JS_SHA256=sha256-BASE64_DIGEST
```

선택 설정은 다음과 같다.

```dotenv
PEAKOS_IBK_TIMEOUT_MS=20000
PEAKOS_IBK_LOOKBACK_DAYS=1
PEAKOS_BANK_AUTO_MATCH_MAX_AGE_DAYS=30
```

`PEAKOS_IBK_TIMEOUT_MS`는 5,000~60,000 ms, `PEAKOS_IBK_LOOKBACK_DAYS`는 1~30 범위다.
자동매칭은 기본적으로 거래 시각 기준 최근 30일 안에 만들어진 후보만 사용한다.
`PEAKOS_BANK_AUTO_MATCH_MAX_AGE_DAYS`는 0~90만 허용하며, `0`은 자동매칭을 완전히 끈다.
형식이 잘못됐거나 90을 넘으면 서버가 시작되지 않아 무제한 과거 매칭으로 완화되지 않는다.

## 최초 해시핀 bootstrap

아래 도구는 계좌 비밀파일이나 프로세스 자격정보를 읽지 않으며 계좌 조회도 하지 않는다. 고정된 공개 `transkey.js` URL만 두 번 내려받아 실행하지 않고, 두 응답이 같을 때 SHA-256 핀 한 줄만 stdout에 출력한다. 다음 명령은 배포 서버가 아닌 격리된 검토 환경에서 실행한다. 이번 검증에서는 공개 파일을 두 번 내려받아 동일 해시를 확인했지만, 이것만으로 운영 핀을 승인한 것은 아니다.

```bash
cd /root/workspaces/jinbong-calendar-business-os/server
env -i PATH=/usr/bin:/bin NODE_ENV=production TZ=UTC \
  /usr/bin/node banking/workers/ibk-asset-pin-bootstrap.js
```

한 번의 HTTPS 다운로드는 코드의 진위를 증명하지 않는 TOFU(최초 신뢰) 자료일 뿐이다. 출력값을 바로 운영에 넣지 말고, 다음을 모두 만족한 뒤 승인한다.

1. 서로 독립된 네트워크/시점에서 동일한 해시가 나오는지 비교한다.
2. IBK 또는 Transkey 공급자가 제공한 검증값, 혹은 별도로 확보해 보안 검토한 정확한 파일 바이트의 SHA-256과 대조한다.
3. 승인한 해시와 검토 일시·검토자를 변경관리 기록에 남긴다.
4. 자산 변경 시 새 해시를 즉시 신뢰하지 않고 다시 검토한다. 불일치 중에는 수집기가 fail-closed 상태를 유지하게 한다.

bootstrap 자체가 자격정보를 읽지 않는지는 다음 구문검사와 단위 테스트로 네트워크 호출 없이 확인할 수 있다.

```bash
cd /root/workspaces/jinbong-calendar-business-os/server
node --check banking/workers/ibk-asset-pin-bootstrap.js
node --test \
  banking/*.test.js \
  banking/collectors/*.test.js \
  banking/providers/*.test.js \
  banking/workers/*.test.js
```

승인한 해시핀을 런타임에만 주입한 조회 전용 `dry-run`은 DB를 쓰지 않으며 거래 총건수, 안정 키·보조 키 건수, 조회기간, 빈 결과 여부만 출력한다. 실패 시에도 위에서 정한 allowlist 오류 코드만 출력한다.

은행 요청보다 먼저 실행하는 오프라인 배포 preflight는 플래그, 승인 핀,
전용 secret loader와 다섯 계좌 ID만 확인한다. 네트워크와 DB를 사용하지 않고
마스킹 계좌번호조차 출력하지 않는다.

```bash
cd /root/workspaces/jinbong-calendar-business-os/server
node banking/ibk-preflight.js
```

`ok:true`, `networkRequestPerformed:false`, `configuredAccountCount:5`를 확인한
뒤에만 아래 live-read를 실행한다. live-read 역시 송금·이체·DB 쓰기를 하지
않지만 실제 은행 조회이므로 운영 담당자가 승인한 핀과 조회 대상 계좌를
확인한 경우에만 실행한다.

```bash
cd /root/workspaces/jinbong-calendar-business-os/server
PEAKOS_IBK_TRANSKEY_JS_SHA256='<approved-sha256>' \
  node banking/ibk-dry-run.js --account '<configured-account-id>' --live-read
```

## 현재 확인 상태

- 비밀파일은 다섯 통장과 공통 식별번호를 포함한 exact 11-key 형식, 권한 `0600`, 상위 디렉터리 `0700`으로 검증했다.
- 다섯 통장 모두 자식 worker까지 전달되는 오프라인 연결 시험을 통과했다.
- 다섯 계좌 모두 조회 전용 실제 `dry-run`과 운영 원장 최초 동기화를 통과했다. 검증 출력은 건수·조회기간·빈 결과 여부만 포함했고 원문 응답은 저장·출력하지 않았다.
- 실제 거래 객체의 필드명만 제한적으로 검사했지만 은행이 보장하는 거래 순번 후보는 발견되지 않았다. 따라서 해당 거래 키는 `providerKeyStable=false`를 유지하며 자동 입금매칭 대상에서 제외한다.
- 현재 자식 worker는 웹 서버와 같은 OS 사용자로 실행되므로 프로세스 분리는 방어선일 뿐, 운영용 보안 경계로 보지 않는다.
- 기존 `calendar-api` 운영 프로세스에는 다섯 통장 조회와 10분 스케줄러가
  활성화되어 있었다. Business OS 전용 web이 가리키는 API upstream이 실제로
  기동되어 있는지는 별도 배포 readiness 항목이며, upstream 502를 수집기
  미연동으로 오인하면 안 된다.
- 2026-08-17 canonical 병합 직후 `calendar_db`는 계좌 5개, 거래
  367건, sync run 1,260건이며 FK·workspace·중복 검증을 통과했다.
  병합한 최신 성공 sync가 2026-08-08이었기 때문에 첫 판정은
  `STALE`이었고, 병합 성공을 현재 잔액 조회 성공으로 간주하지
  않았다. 이후 14:20 UTC 기존 scheduler가 5계좌 모두 성공하여
  sync run 1,265건·거래 370건이 되었고, DB-only readiness는 `HEALTHY`로
  전환되었다. 수동 live-read는 실행하지 않았다.
- Business OS API를 별도 포트로 기동할 때는 IBK 세 변수뿐 아니라 OS 이메일
  인증 HMAC, 금융·영업 암호화 키, UID 권한표와 DB readiness를 같은 프로세스에
  주입해야 한다. 하나라도 빠져 서버가 기동하지 않으면 통장 API도 모두 502다.
- `PEAKOS_BANK_AUTO_MATCH_MAX_AGE_DAYS=0`을 유지해 정산서 입금확인·충전금
  승인은 수행하지 않는다. “읽기 전용 해제”는 통장 조회 수집기에 이체 권한을
  추가한다는 뜻으로 해석하지 않는다.

## canonical DB 병합

기존 `calendar_business_os` 원장을 `calendar_db`로 옮길 때는
`peakos-bank-canonical-merge.js`만 사용한다. 기본 실행은 읽기 전용
preflight이며, 다섯 계좌의 ID·활성 상태·마스킹 번호, 거래 자연키, 동기화
request ID, 대상 workspace 충돌만 검사한다. 거래 금액·잔액·상대방·감사
내용은 출력하지 않는다.

```bash
cd /root/workspaces/jinbong-calendar-business-os/server
node banking/peakos-bank-canonical-merge.js
```

preflight가 성공하고 DB 백업·점검창이 확인된 경우에만 명시적으로 적용한다.

```bash
node banking/peakos-bank-canonical-merge.js --apply
```

적용 모드는 target serializable transaction과 전용 advisory lock을
먼저 획득한 뒤, **같은 transaction 안에서**
`20260817_peakos_bank_workspace_merge.sql`과 병합을 순서대로 처리한다.
source는 repeatable-read/read-only다. 식별 기준은 계좌 ID, `(account ID, provider
transaction key)`, sync `request_id`, legacy allocation/audit source key다. 따라서
같은 명령을 다시 실행하면 중복이 생기지 않으며, 같은 키의 금액·구분·시각이
달라진 경우 전체 transaction을 중단한다. 대상 bank root는 모두
`workspace_id='ws_peak'` NOT NULL 및 workspace/composite FK로 보강된다.
운영 `--apply`는 예정된 source 건수
`5/367/1260/0/1302`(계좌/거래/run/배분/감사)가 하나라도 다르면
모든 쓰기 전에 중단하고 rollback한다.

## 수집기 입력 계약

수집기는 거래를 다음 형태로 정규화해 전달해야 한다. 시간은 타임존이 포함된 RFC 3339 형식을 사용한다.

```json
{
  "transactions": [
    {
      "providerTransactionKey": "provider-opaque-id",
      "providerKeyStable": true,
      "transactionAt": "2026-08-06T15:20:00+09:00",
      "direction": "DEPOSIT",
      "amount": 110000,
      "balance": 5020000,
      "summary": "입금",
      "counterpartyName": "테스트거래처"
    }
  ]
}
```

`providerKeyStable`은 은행이 제공한 거래 순번으로 키를 만들었을 때만 `true`다. 순번이 없어 거래 필드 지문으로 만든 보조 키는 `false`로 전달한다. `counterpartyAccount`는 저장 전 마스킹된다. 불안정 키 거래는 원장에는 보관할 수 있지만 자동 입금매칭·충전금 반영 대상에서는 제외한다. 후보가 모호한 경우도 `PROPOSED`로 남겨 사람이 검토한다.

## 자동 정산·충전 승인 전 필수 조건

1. IBK 정식 기업뱅킹·펌뱅킹 조회 API 계약 가능 여부를 먼저 확인하고, 가능하면 화면 자동화 대신 공식 API를 사용
2. 다섯 통장의 빠른조회 등록 여부와 비밀파일의 공통 식별번호가 사업자번호 뒤 7자리인지 사용자 확인
3. 자격정보를 넣었던 기존 파일·채널의 조회 비밀번호와 관련 secret 교체
4. 실제 성공 응답에서 민감정보를 제거한 fixture로 거래 행 형식과 은행 고유 거래 순번을 확정
5. 웹 서버와 다른 OS 사용자·서비스로 조회 worker를 분리하고, 시크릿 매니저와 IBK 도메인 전용 네트워크 정책 구성
6. 다섯 통장 원장과 실제 IBK 내역을 충분한 기간 대조
7. 공식 불변 거래번호가 들어온 뒤에만 자동매칭 기간을 0보다 크게 바꾸고 별도 승인
