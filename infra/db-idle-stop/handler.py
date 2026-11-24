"""Stops the Superstar RDS instance when no client has been connected for IDLE_MINUTES.

Runs on an EventBridge Scheduler schedule. RDS publishes DatabaseConnections every minute while
the instance runs. The instance is stopped only when the metric covers the whole window (so a
freshly started instance is never stopped before the app has had time to connect) and every
data point in it is zero. AWS restarts a stopped instance after 7 days; this stops it again.
"""
import datetime as dt
import json
import os

import boto3

DB_ID = os.environ["DB_INSTANCE_ID"]
IDLE_MINUTES = int(os.environ.get("IDLE_MINUTES", "45"))

rds = boto3.client("rds")
cloudwatch = boto3.client("cloudwatch")


def handler(event, context):
    instance = rds.describe_db_instances(DBInstanceIdentifier=DB_ID)["DBInstances"][0]
    status = instance["DBInstanceStatus"]
    if status != "available":
        return log(action="skip", reason=f"status {status}")

    end = dt.datetime.now(dt.timezone.utc)
    points = cloudwatch.get_metric_statistics(
        Namespace="AWS/RDS",
        MetricName="DatabaseConnections",
        Dimensions=[{"Name": "DBInstanceIdentifier", "Value": DB_ID}],
        StartTime=end - dt.timedelta(minutes=IDLE_MINUTES),
        EndTime=end,
        Period=60,
        Statistics=["Maximum"],
    )["Datapoints"]

    # Require (almost) full coverage of the window; missing minutes mean the instance just started.
    if len(points) < IDLE_MINUTES - 5:
        return log(action="skip", reason=f"only {len(points)} minutes of data (needs {IDLE_MINUTES - 5})")
    busiest = max(p["Maximum"] for p in points)
    if busiest > 0:
        return log(action="keep", reason=f"up to {busiest:.0f} connections in the last {IDLE_MINUTES} minutes")

    rds.stop_db_instance(DBInstanceIdentifier=DB_ID)
    return log(action="stop", reason=f"no connections for {IDLE_MINUTES} minutes")


def log(**fields):
    fields["db"] = DB_ID
    print(json.dumps(fields))
    return fields
