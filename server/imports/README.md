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

## 현재 원본 최신분 증분 반영

최초 이관 뒤 Google 원본에 추가·교정된 행은 `settlement-refresh-cli.js`로만 반영한다. 이 경로는 원본에서 사라진 행을 삭제하지 않으며, 신규 격리 행이나 OS에서 수동 수정된 행과 원본 교정이 겹치면 전체 transaction을 중단한다. 현재 source map의 7개 문서 식별자는 최초 완료 이관 run의 hash 스냅샷과 exact 일치해야 하며, 원장은 current map 필터가 아닌 전체 import lineage를 대조한다. 개인 원장은 `peakos_intake` 하나를 개인정산서와 최종정산서가 함께 읽고, 월보장·월관리·직접실행 원장은 `peakos_monthly`를 최종실행정산서가 읽으므로 별도의 UI 복사본을 만들지 않는다.

먼저 DBA/operator 계정으로 schema migration을 적용한다. runtime 역할(`calendar_user`)로 migration을 실행하면 의도적으로 실패한다. migration은 refresh audit 테이블만 만들며 정산 원장 행은 수정하지 않는다.

```bash
psql "$PEAKOS_OPERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f migrations/20260818_peakos_settlement_source_refresh.sql
```

운영 DB 전체 백업은 dry-run 전에 별도로 생성해야 한다. CLI는 24시간 이내의 mode `600`, 1KB 이상 일반 파일만 허용하고 파일 전체 SHA-256을 report에 pin한다. 아래의 PostgreSQL 환경변수는 반드시 현재 원장과 최초 완료 이관 run이 있는 canonical DB를 가리켜야 한다. 빈 DB나 잘못 선택한 DB는 schema를 만들거나 데이터를 쓰기 전에 거부된다.

Google 원본은 dry-run·apply에서 직접 다시 받지 않는다. 먼저 존재하지 않는 새 경로에 7개 XLSX를 한 번만 capture한다. 도구는 디렉터리를 mode `700`, 각 XLSX와 식별자·이름이 없는 `capture-manifest.json`을 mode `600`으로 atomic 생성하고 HTTP·ZIP·크기·SHA-256을 pin한다. 중간 실패 디렉터리는 자동 제거된다.

```bash
node imports/settlement-source-capture-cli.js capture \
  --source-map-file /private/source-map.json \
  --source-dir /private/settlement-source-20260817 \
  --timeout-ms 120000
```

capture 중 시트가 수정될 수 있으므로 capture 후 같은 `--source-dir`을 두 번 파싱해 capture/source/plan/operation digest와 delta가 exact인지 검토한다. 검토된 디렉터리는 수정하지 않고 dry-run과 apply에 같은 경로를 사용한다. refresh CLI에는 live Google fallback이 없으며 `--source-dir`이 없으면 즉시 실패한다.

```bash
node imports/settlement-refresh-cli.js dry-run \
  --source-map-file /private/source-map.json \
  --uid-map-file /private/uid-map.json \
  --source-dir /private/settlement-source-20260817 \
  --backup-file /private/calendar_db.before-refresh.dump \
  --report-out /private/settlement-refresh-dry-run.json \
  --expect-intake-insert 84 \
  --expect-monthly-insert 6 \
  --expect-intake-update 48 \
  --expect-monthly-update 0 \
  --expect-missing 0 \
  --expect-conflict 0
```

출력의 `safe=true`, `missing=0`, `conflict=0`, `newQuarantine=0`을 확인한다. launch delta는 operator가 고정 snapshot을 2회 파싱해 검토한 `84+6 INSERT / 48+0 UPDATE / 0 missing / 0 conflict`와 exact 일치해야 report가 생성된다. 영업 시트가 수정 중이라 한 건이라도 달라지면 새 backup·capture·검토·dry-run 없이 기대값을 바꾸지 않는다. report에는 capture manifest, source manifest, 전체 정규화 plan, 현재 DB 상태, 반영 작업 목록, 백업 파일의 해시가 각각 pin된다. apply는 같은 capture·DB·백업과 24시간 이내 report가 모두 일치할 때만 실행된다.

```bash
PEAKOS_SETTLEMENT_ACTOR_UID='operator-firebase-uid' \
PEAKOS_SETTLEMENT_ACTOR_NAME='운영 담당자' \
node imports/settlement-refresh-cli.js apply \
  --source-map-file /private/source-map.json \
  --uid-map-file /private/uid-map.json \
  --source-dir /private/settlement-source-20260817 \
  --backup-file /private/calendar_db.before-refresh.dump \
  --report-in /private/settlement-refresh-dry-run.json \
  --expect-intake-insert 84 \
  --expect-monthly-insert 6 \
  --expect-intake-update 48 \
  --expect-monthly-update 0 \
  --expect-missing 0 \
  --expect-conflict 0 \
  --confirm APPLY_CURRENT_SETTLEMENT_REFRESH
```

반영은 `SERIALIZABLE` transaction, API advisory lock, 원장 table lock 안에서 처리한다. 신규 행은 INSERT, 기존 원본 교정은 마지막 import/refresh snapshot과 현재 OS 행의 전체 fingerprint가 같은 경우에만 UPDATE한다. 성공 후 같은 source 전체가 exact match인지 다시 대조한 뒤 commit한다. 같은 원본을 재실행하면 write 없이 `noOp=true`가 된다.

배포 후 PII를 출력하지 않는 집계 검증 예시는 다음과 같다.

```sql
SELECT status, inserted_count, updated_count, skipped_count,
       conflict_count, quarantine_count, completed_at IS NOT NULL AS completed
  FROM peakos_settlement_refresh_runs
 WHERE workspace_id = 'ws_peak'
 ORDER BY created_at DESC
 LIMIT 1;

SELECT COUNT(*) AS intake_rows, MAX(date) AS intake_latest
  FROM peakos_intake
 WHERE workspace_id = 'ws_peak';

SELECT COUNT(*) AS execution_rows, MAX(date) AS execution_latest
  FROM peakos_monthly
 WHERE workspace_id = 'ws_peak';
```

apply 후 되돌려야 할 때는 애플리케이션과 background job을 먼저 중지하고, dry-run에 pin된 전체 DB 백업을 DBA 절차로 복구한다. refresh는 이번 고정 snapshot의 48개 행처럼 원본 교정 UPDATE도 포함하므로 일부 DELETE만 수행하는 수동 롤백은 금지한다. 복구 뒤 위 집계와 최초 import run의 `COMPLETED` 상태를 다시 확인한다.
