# 2026-06/07/08 정산 이관 도구

이 디렉터리는 확정된 직원 7명의 Google Sheet 스냅샷을 PEAK OS 정산 테이블로 한 번만 이관하는 운영 도구다. Google 문서 ID, Firebase UID, 이메일은 저장소에 두지 않는다. 실제 운영 DB 쓰기 전에 반드시 같은 비공개 XLSX 파일로 `dry-run`과 `apply`를 차례로 실행한다.

필수 입력:

- `--source-dir`: mode `700`인 디렉터리. 내부의 고정 파일명 7개는 mode `600` 권장.
- `PEAKOS_SETTLEMENT_SOURCE_MAP_JSON` 또는 mode `600` `--source-map-file`: 정확한 7개 external document ID.
- `PEAKOS_SETTLEMENT_UID_MAP_JSON` 또는 mode `600` `--uid-map-file`: 정확한 7명의 `{ "uid", "email" }`. DB의 name/email/approved/active와 모두 일치해야 한다.
- PostgreSQL 연결 환경변수와 실행자 `PEAKOS_SETTLEMENT_ACTOR_UID`.

워크스페이스에서 dev dependency를 포함해 설치한 뒤 실행한다. 운영 서버 런타임은 ExcelJS를 로드하지 않는다.

```bash
cd server
npm ci
node imports/settlement-import-cli.js dry-run \
  --source-dir /private/sources \
  --source-map-file /private/source-map.json \
  --uid-map-file /private/uid-map.json \
  --report-out /private/dry-run-report.json \
  --quarantine-out /private/quarantine.json
```

`baselineOk=true`를 확인한 뒤, 동일한 파일과 생성된 report를 사용한다. 파일 내용 해시뿐 아니라 정규화된 전체 target plan 해시가 다르면 적용이 거부된다.

```bash
node imports/settlement-import-cli.js apply \
  --source-dir /private/sources \
  --source-map-file /private/source-map.json \
  --uid-map-file /private/uid-map.json \
  --report-in /private/dry-run-report.json \
  --rollback-out /private/rollback-manifest.json \
  --confirm IMPORT_2026_06_07_08
```

이관은 serializable transaction과 table lock 안에서 수행하며, commit 직전에 DB 건수/K/L/N/특수정산/parent/격리 건수를 plan과 다시 비교한다. 과거 행은 `bank_match_eligible=false`, `paid_auto=false`로 저장된다.

롤백은 생성된 mode `600` manifest가 DB run 및 각 항목 fingerprint와 일치할 때만 가능하다. 이관 후 OS에서 편집해 `row_version`이나 material fingerprint가 바뀐 행이 하나라도 있으면 전체 롤백이 중단된다.

```bash
node imports/settlement-import-cli.js rollback \
  --rollback-in /private/rollback-manifest.json \
  --confirm ROLLBACK_SETTLEMENT_IMPORT
```

표준 출력에는 직원/월별 건수와 안전한 exception code/row 번호만 나오며, 업체명·입금자명·전체 이메일·UID·문서 ID는 출력하지 않는다. 원문 격리 자료는 명시한 mode `600` 파일에만 기록한다.
