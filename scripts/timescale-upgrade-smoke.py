#!/usr/bin/env python3
"""Rehearse the two-stage Timescale upgrade using isolated synthetic data."""
import argparse
import json
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-image", required=True)
    parser.add_argument("--bridge-image", required=True)
    parser.add_argument("--target-image", required=True)
    args = parser.parse_args()
    name = "tradejs-timescale-smoke-" + uuid.uuid4().hex[:12]
    volume = name + "-data"
    results = []

    def run(command, data=None):
        p = subprocess.run(command, input=data, capture_output=True, timeout=180)
        if p.returncode:
            raise RuntimeError(p.stderr.decode("utf8", "replace")[-3000:])
        return p.stdout

    def sql(query, database="smoke"):
        return run([
            "docker", "exec", name, "psql", "-X", "-v", "ON_ERROR_STOP=1",
            "-A", "-t", "-U", "fixture", "-d", database, "-c", query,
        ]).decode().strip()

    def start(image, maintenance=False):
        command = [
            "docker", "run", "-d", "--name", name, "--network", "none",
            "--sysctl", "net.mptcp.enabled=0", "--memory", "1g", "--cpus", "1",
            "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture-only",
            "-e", "POSTGRES_DB=smoke", "-v", volume + ":/var/lib/postgresql/data",
            image,
        ]
        if maintenance:
            command += ["postgres", "-c", "timescaledb.max_background_workers=0"]
        run(command)
        for _ in range(120):
            # pg_isready can see the temporary initdb server before entrypoint
            # stops it. Wait for the final postgres process to become PID 1.
            process = subprocess.run([
                "docker", "exec", name, "cat", "/proc/1/comm",
            ], capture_output=True)
            p = subprocess.run([
                "docker", "exec", name, "pg_isready", "-U", "fixture", "-d", "smoke",
            ], capture_output=True)
            if process.stdout.strip() == b"postgres" and p.returncode == 0:
                return
            time.sleep(0.5)
        raise RuntimeError("Isolated database did not become ready")

    def stop():
        run(["docker", "stop", "--time", "30", name])
        run(["docker", "rm", name])

    def verify(pg, extension):
        versions = sql("SELECT current_setting('server_version_num'); "
                       "SELECT extversion FROM pg_extension WHERE extname='timescaledb';")
        assert versions.splitlines() == [pg, extension], versions
        totals = sql("SELECT count(*),sum(value) FROM migration_fixture;")
        assert totals == "1000|500500", totals
        aggregate = sql("SELECT sum(n),sum(total) FROM fixture_daily;")
        assert aggregate == "1000|500500", aggregate
        assert int(sql("SELECT count(*) FROM timescaledb_information.chunks "
                       "WHERE hypertable_name='migration_fixture' AND is_compressed;")) > 0
        # Execute only this fixture's retention policy, never a production job.
        run([
            "docker", "exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1",
            "-U", "fixture", "-d", "smoke",
        ], b"SELECT job_id FROM timescaledb_information.jobs "
           b"WHERE hypertable_name='migration_fixture' AND proc_name='policy_retention' \\gset\n"
           b"CALL run_job(:job_id);\n")
        assert sql("SELECT count(*),sum(value) FROM migration_fixture;") == totals
        # Exercise the write paths again with each server/extension combination.
        sql("CREATE TABLE write_fixture(ts timestamptz NOT NULL,value integer NOT NULL); "
            "SELECT create_hypertable('write_fixture','ts',chunk_time_interval=>interval '1 day'); "
            "INSERT INTO write_fixture SELECT timestamptz '2000-01-01' + i*interval '1 minute',i "
            "FROM generate_series(1,20) i; "
            "ALTER TABLE write_fixture SET(timescaledb.compress,timescaledb.compress_orderby='ts'); "
            "SELECT compress_chunk(c) FROM show_chunks('write_fixture') c;")
        sql("CREATE MATERIALIZED VIEW write_daily WITH(timescaledb.continuous) AS "
            "SELECT time_bucket(interval '1 day',ts) bucket,count(*) n,sum(value) total "
            "FROM write_fixture GROUP BY 1 WITH NO DATA;")
        sql("CALL refresh_continuous_aggregate('write_daily',NULL,NULL);")
        assert sql("SELECT sum(n),sum(total) FROM write_daily;") == "20|210"
        sql("INSERT INTO write_fixture VALUES(timestamptz '2000-02-01',999);")
        sql("CALL refresh_continuous_aggregate('write_daily',NULL,NULL);")
        assert sql("SELECT sum(n),sum(total) FROM write_daily;") == "21|1209"
        sql("SELECT decompress_chunk(format('%I.%I',chunk_schema,chunk_name)::regclass) "
            "FROM timescaledb_information.chunks "
            "WHERE hypertable_name='write_fixture' AND is_compressed;")
        assert sql("SELECT count(*),sum(value) FROM write_fixture;") == "21|1209"
        sql("SELECT compress_chunk(c) FROM show_chunks('write_fixture') c;")
        sql("SELECT add_retention_policy('write_fixture',interval '1 day');")
        run([
            "docker", "exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1",
            "-U", "fixture", "-d", "smoke",
        ], b"SELECT job_id FROM timescaledb_information.jobs "
           b"WHERE hypertable_name='write_fixture' AND proc_name='policy_retention' \\gset\n"
           b"CALL run_job(:job_id);\n")
        assert sql("SELECT count(*) FROM write_fixture;") == "0"
        sql("DROP MATERIALIZED VIEW write_daily; DROP TABLE write_fixture;")
        results.append({"postgres": pg, "timescaledb": extension,
                        "rows_and_aggregate": "preserved", "compressed_chunks": "readable",
                        "new_chunk_insert_refresh_compress_decompress": "passed",
                        "fixture_retention_job": "deleted only synthetic expired chunks"})

    run(["docker", "volume", "create", volume])
    try:
        start(args.old_image)
        # Initialization may have installed the image's default extension.
        sql("DROP EXTENSION IF EXISTS timescaledb;")
        sql("CREATE EXTENSION timescaledb VERSION '2.26.2';")
        sql("CREATE TABLE migration_fixture(ts timestamptz NOT NULL,value integer NOT NULL); "
            "SELECT create_hypertable('migration_fixture','ts',chunk_time_interval=>interval '1 day'); "
            "INSERT INTO migration_fixture SELECT timestamptz '2026-01-01' + i*interval '1 hour',i "
            "FROM generate_series(1,1000) i; "
            "ALTER TABLE migration_fixture SET(timescaledb.compress,timescaledb.compress_orderby='ts'); "
            "SELECT compress_chunk(c) FROM show_chunks('migration_fixture') c;")
        sql("CREATE MATERIALIZED VIEW fixture_daily WITH(timescaledb.continuous) AS "
            "SELECT time_bucket(interval '1 day',ts) bucket,count(*) n,sum(value) total "
            "FROM migration_fixture GROUP BY 1 WITH NO DATA;")
        sql("CALL refresh_continuous_aggregate('fixture_daily',NULL,NULL);")
        sql("SELECT add_retention_policy('migration_fixture',interval '1000 years');")
        verify("160015", "2.26.2")
        stop()
        start(args.bridge_image, maintenance=True)
        # Must be the first SQL statement in a fresh psql -X session.
        sql("ALTER EXTENSION timescaledb UPDATE TO '2.32.1';")
        verify("160015", "2.32.1")
        stop()
        start(args.target_image)
        verify("160016", "2.32.1")
        stop()
        start(args.target_image)
        verify("160016", "2.32.1")
        print(json.dumps({"status": "passed", "stages": results}))
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


if __name__ == "__main__":
    main()
