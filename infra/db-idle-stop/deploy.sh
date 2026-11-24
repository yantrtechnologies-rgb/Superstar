#!/usr/bin/env bash
# Deploys (or updates) the RDS idle-stop function and its 15-minute schedule in the project Region.
# Usage: bash infra/db-idle-stop/deploy.sh   (uses the `superstar` AWS CLI profile)
set -euo pipefail
export MSYS_NO_PATHCONV=1  # keep /aws/lambda/... names intact in Git Bash on Windows
HERE=$(cd "$(dirname "$0")" && pwd); cd "$HERE"
A="${AWS_CLI:-aws}"
REGION=ap-southeast-2
PROFILE=superstar
P=(--region "$REGION" --profile "$PROFILE" --output text)
DB_ID=superstar-db
FN=superstar-db-idle-stop
ACCOUNT=$("$A" sts get-caller-identity --query Account "${P[@]}")
DB_ARN="arn:aws:rds:$REGION:$ACCOUNT:db:$DB_ID"
LOG_ARN="arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/lambda/$FN:*"
TMP=$(mktemp -d)
win() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

# 1. Execution role: read this one instance, stop it, read RDS metrics, write its own logs.
cat > "$TMP/lambda-trust.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole",
"Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}]}
JSON
cat > "$TMP/lambda-policy.json" <<JSON
{"Version":"2012-10-17","Statement":[
{"Sid":"ThisDatabaseOnly","Effect":"Allow","Action":["rds:DescribeDBInstances","rds:StopDBInstance"],"Resource":"$DB_ARN"},
{"Sid":"ReadMetrics","Effect":"Allow","Action":"cloudwatch:GetMetricStatistics","Resource":"*"},
{"Sid":"OwnLogs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":["arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/lambda/$FN","$LOG_ARN"]}]}
JSON
if ! "$A" iam get-role --role-name "$FN-role" "${P[@]}" >/dev/null 2>&1; then
  "$A" iam create-role --role-name "$FN-role" --assume-role-policy-document "file://$(win "$TMP/lambda-trust.json")" \
    --tags Key=project,Value=superstar "${P[@]}" >/dev/null
  echo "created role $FN-role"; sleep 10
fi
"$A" iam put-role-policy --role-name "$FN-role" --policy-name idle-stop --policy-document "file://$(win "$TMP/lambda-policy.json")" "${P[@]}"
ROLE_ARN=$("$A" iam get-role --role-name "$FN-role" --query Role.Arn "${P[@]}")

# 2. Function (Python, no dependencies beyond boto3, which the runtime includes).
( cd "$HERE" && python -c "import zipfile; z=zipfile.ZipFile(r'$(win "$TMP/fn.zip")','w',zipfile.ZIP_DEFLATED); z.write('handler.py'); z.close()" )
"$A" logs create-log-group --log-group-name "/aws/lambda/$FN" "${P[@]}" 2>/dev/null || true
"$A" logs put-retention-policy --log-group-name "/aws/lambda/$FN" --retention-in-days 14 "${P[@]}"
if "$A" lambda get-function --function-name "$FN" "${P[@]}" >/dev/null 2>&1; then
  "$A" lambda update-function-code --function-name "$FN" --zip-file "fileb://$(win "$TMP/fn.zip")" "${P[@]}" >/dev/null
  "$A" lambda wait function-updated --function-name "$FN" "${P[@]}"
  echo "updated function $FN"
else
  for i in 1 2 3 4 5 6; do
    if "$A" lambda create-function --function-name "$FN" --runtime python3.13 --architectures arm64 --handler handler.handler \
      --role "$ROLE_ARN" --zip-file "fileb://$(win "$TMP/fn.zip")" --timeout 30 --memory-size 128 \
      --environment "Variables={DB_INSTANCE_ID=$DB_ID,IDLE_MINUTES=45}" --tags project=superstar "${P[@]}" >/dev/null 2>"$TMP/err"; then break; fi
    grep -q "cannot be assumed" "$TMP/err" || { cat "$TMP/err"; exit 1; }
    echo "waiting for the new role to propagate..."; sleep 10
  done
  "$A" lambda wait function-active-v2 --function-name "$FN" "${P[@]}"
  echo "created function $FN"
fi
FN_ARN=$("$A" lambda get-function --function-name "$FN" --query Configuration.FunctionArn "${P[@]}")

# 3. Scheduler role that may invoke only this function, and the 15-minute schedule.
cat > "$TMP/sched-trust.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole",
"Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}]}
JSON
cat > "$TMP/sched-policy.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":["$FN_ARN","$FN_ARN:*"]}]}
JSON
if ! "$A" iam get-role --role-name "$FN-scheduler" "${P[@]}" >/dev/null 2>&1; then
  "$A" iam create-role --role-name "$FN-scheduler" --assume-role-policy-document "file://$(win "$TMP/sched-trust.json")" \
    --tags Key=project,Value=superstar "${P[@]}" >/dev/null
  echo "created role $FN-scheduler"; sleep 10
fi
"$A" iam put-role-policy --role-name "$FN-scheduler" --policy-name invoke --policy-document "file://$(win "$TMP/sched-policy.json")" "${P[@]}"
SCHED_ROLE=$("$A" iam get-role --role-name "$FN-scheduler" --query Role.Arn "${P[@]}")
TARGET="{\"Arn\":\"$FN_ARN\",\"RoleArn\":\"$SCHED_ROLE\",\"RetryPolicy\":{\"MaximumRetryAttempts\":0}}"
if "$A" scheduler get-schedule --name "$FN" "${P[@]}" >/dev/null 2>&1; then
  "$A" scheduler update-schedule --name "$FN" --schedule-expression "rate(15 minutes)" --flexible-time-window Mode=OFF --target "$TARGET" "${P[@]}" >/dev/null
  echo "updated schedule $FN"
else
  for i in 1 2 3 4 5 6; do
    "$A" scheduler create-schedule --name "$FN" --schedule-expression "rate(15 minutes)" --flexible-time-window Mode=OFF \
      --target "$TARGET" --description "Stop superstar-db when idle" "${P[@]}" >/dev/null 2>"$TMP/err" && break
    grep -qi "assume\|role" "$TMP/err" || { cat "$TMP/err"; exit 1; }
    echo "waiting for the scheduler role to propagate..."; sleep 10
  done
  echo "created schedule $FN (every 15 minutes)"
fi
rm -rf "$TMP"
