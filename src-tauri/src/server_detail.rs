use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::{error::CommandError, sftp::SftpState};

const INFO_COMMAND: &str = r#"
printf '===HOSTNAME===\n'; (hostname -f 2>/dev/null || hostname)
printf '===OS===\n'; (awk -F= '/^PRETTY_NAME=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release 2>/dev/null || uname -s)
printf '===KERNEL===\n'; uname -r
printf '===ARCH===\n'; uname -m
printf '===UPTIME===\n'; (uptime -p 2>/dev/null || uptime)
printf '===LOAD===\n'; (cat /proc/loadavg 2>/dev/null || uptime)
printf '===CPUS===\n'; (nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
printf '===CPUMHZ===\n'; awk '/cpu MHz/{s+=$4;c++} END{if(c) printf "%.2f\n",s/c;else print 0}' /proc/cpuinfo 2>/dev/null
"#;

const METRICS_COMMAND: &str = r#"
printf '===CPU1===\n'; awk '/^cpu /{print "T",$2,$3,$4,$5,$6,$7,$8,$9}/^cpu[0-9]+ /{c=$1;sub(/^cpu/,"",c);print "C" c,$2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat
printf '===NET1===\n'; awk 'NR>2{n=$1;gsub(/:/,"",n);print n,$2,$10}' /proc/net/dev
sleep 1
printf '===CPU2===\n'; awk '/^cpu /{print "T",$2,$3,$4,$5,$6,$7,$8,$9}/^cpu[0-9]+ /{c=$1;sub(/^cpu/,"",c);print "C" c,$2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat
printf '===NET2===\n'; awk 'NR>2{n=$1;gsub(/:/,"",n);print n,$2,$10}' /proc/net/dev
printf '===STATIC===\n'
awk '/^MemTotal:/{mt=$2*1024}/^MemAvailable:/{ma=$2*1024} END{print "MT",mt;print "MU",mt-ma}' /proc/meminfo
df -B1 -P / | awk 'NR==2{print "DU",$3;print "DT",$2}'
ps -eo comm=,%mem=,rss= --sort=-rss | head -6 | awk '{print "MP",$1,$2,$3*1024}'
awk '/cpu MHz/{s+=$4;c++} END{if(c) printf "CM %.2f\n",s/c;else print "CM 0"}' /proc/cpuinfo
"#;

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ServerInfo {
    hostname: String,
    os: String,
    kernel: String,
    arch: String,
    uptime: String,
    load_avg: String,
    load_avg_detail: String,
    cpus: i64,
    cpu_mhz: f64,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct NetIfStat {
    name: String,
    rx: i64,
    tx: i64,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ProcMem {
    name: String,
    percent: f64,
    rss: i64,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ServerMetrics {
    cpu: f64,
    cpu_detail: Vec<f64>,
    mem_used: i64,
    mem_total: i64,
    mem_percent: f64,
    mem_detail: Vec<ProcMem>,
    disk_used: i64,
    disk_total: i64,
    disk_percent: f64,
    cpu_mhz: f64,
    net_rx: i64,
    net_tx: i64,
    net_detail: Vec<NetIfStat>,
    timestamp: i64,
}

#[derive(Debug, Clone, Copy, Default)]
struct CpuCounters {
    total: u64,
    idle: u64,
}

fn sections(output: &str) -> HashMap<&str, &str> {
    let mut result = HashMap::new();
    let mut current = None;
    let mut start = 0;
    for (offset, line) in output.split_inclusive('\n').scan(0, |position, line| {
        let offset = *position;
        *position += line.len();
        Some((offset, line))
    }) {
        let trimmed = line.trim();
        if trimmed.starts_with("===") && trimmed.ends_with("===") {
            if let Some(name) = current {
                result.insert(name, output[start..offset].trim());
            }
            current = Some(trimmed.trim_matches('='));
            start = offset + line.len();
        }
    }
    if let Some(name) = current {
        result.insert(name, output[start..].trim());
    }
    result
}

fn parse_info(output: &str) -> ServerInfo {
    let values = sections(output);
    let value = |name| values.get(name).copied().unwrap_or_default().to_owned();
    let load_avg_detail = value("LOAD");
    let load_avg = load_avg_detail
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" / ");
    ServerInfo {
        hostname: value("HOSTNAME"),
        os: value("OS"),
        kernel: value("KERNEL"),
        arch: value("ARCH"),
        uptime: value("UPTIME"),
        load_avg,
        load_avg_detail,
        cpus: value("CPUS").parse().unwrap_or(1),
        cpu_mhz: value("CPUMHZ").parse().unwrap_or_default(),
    }
}

fn parse_cpu(value: &str) -> HashMap<String, CpuCounters> {
    value
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 9 {
                return None;
            }
            let counters = fields[1..9]
                .iter()
                .map(|value| value.parse::<u64>().unwrap_or_default())
                .collect::<Vec<_>>();
            Some((
                fields[0].to_owned(),
                CpuCounters {
                    total: counters.iter().sum(),
                    idle: counters[3] + counters[4],
                },
            ))
        })
        .collect()
}

fn percentage(before: CpuCounters, after: CpuCounters) -> f64 {
    let total = after.total.saturating_sub(before.total);
    let idle = after.idle.saturating_sub(before.idle);
    if total == 0 || idle > total {
        0.0
    } else {
        (total - idle) as f64 / total as f64 * 100.0
    }
}

fn parse_net(value: &str) -> HashMap<String, (u64, u64)> {
    value
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            (fields.len() >= 3).then(|| {
                (
                    fields[0].to_owned(),
                    (
                        fields[1].parse().unwrap_or_default(),
                        fields[2].parse().unwrap_or_default(),
                    ),
                )
            })
        })
        .collect()
}

fn parse_metrics(output: &str) -> ServerMetrics {
    let values = sections(output);
    let before_cpu = parse_cpu(values.get("CPU1").copied().unwrap_or_default());
    let after_cpu = parse_cpu(values.get("CPU2").copied().unwrap_or_default());
    let before_net = parse_net(values.get("NET1").copied().unwrap_or_default());
    let after_net = parse_net(values.get("NET2").copied().unwrap_or_default());
    let mut metrics = ServerMetrics {
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };
    if let (Some(before), Some(after)) = (before_cpu.get("T"), after_cpu.get("T")) {
        metrics.cpu = percentage(*before, *after);
    }
    let mut cores = after_cpu
        .keys()
        .filter(|name| name.starts_with('C'))
        .cloned()
        .collect::<Vec<_>>();
    cores.sort_by_key(|name| {
        name.trim_start_matches('C')
            .parse::<usize>()
            .unwrap_or_default()
    });
    for core in cores {
        if let (Some(before), Some(after)) = (before_cpu.get(&core), after_cpu.get(&core)) {
            metrics.cpu_detail.push(percentage(*before, *after));
        }
    }
    let mut interfaces = after_net.keys().cloned().collect::<Vec<_>>();
    interfaces.sort();
    for name in interfaces {
        if name == "lo" || name.starts_with("br-") {
            continue;
        }
        let before = before_net.get(&name).copied().unwrap_or_default();
        let after = after_net.get(&name).copied().unwrap_or_default();
        let rx = after.0.saturating_sub(before.0) as i64;
        let tx = after.1.saturating_sub(before.1) as i64;
        metrics.net_rx += rx;
        metrics.net_tx += tx;
        metrics.net_detail.push(NetIfStat { name, rx, tx });
    }
    for line in values.get("STATIC").copied().unwrap_or_default().lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        match fields.first().copied() {
            Some("MT") => metrics.mem_total = parse_i64(&fields, 1),
            Some("MU") => metrics.mem_used = parse_i64(&fields, 1),
            Some("DU") => metrics.disk_used = parse_i64(&fields, 1),
            Some("DT") => metrics.disk_total = parse_i64(&fields, 1),
            Some("CM") => {
                metrics.cpu_mhz = fields
                    .get(1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_default()
            }
            Some("MP") if fields.len() >= 4 => metrics.mem_detail.push(ProcMem {
                name: fields[1].into(),
                percent: fields[2].parse().unwrap_or_default(),
                rss: parse_i64(&fields, 3),
            }),
            _ => {}
        }
    }
    if metrics.mem_total > 0 {
        metrics.mem_percent = metrics.mem_used as f64 / metrics.mem_total as f64 * 100.0;
    }
    if metrics.disk_total > 0 {
        metrics.disk_percent = metrics.disk_used as f64 / metrics.disk_total as f64 * 100.0;
    }
    metrics
}

fn parse_i64(values: &[&str], index: usize) -> i64 {
    values
        .get(index)
        .and_then(|value| value.parse().ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn server_get_info(
    state: State<'_, SftpState>,
    session_id: String,
) -> Result<ServerInfo, CommandError> {
    let (output, code) = state.exec(&session_id, INFO_COMMAND).await?;
    if code != 0 {
        return Err(CommandError::new(
            "EXEC_FAILED",
            format!("command exited with status {code}"),
        ));
    }
    Ok(parse_info(&output))
}

#[tauri::command]
pub async fn server_get_metrics(
    state: State<'_, SftpState>,
    session_id: String,
) -> Result<ServerMetrics, CommandError> {
    let (output, code) = state.exec(&session_id, METRICS_COMMAND).await?;
    if code != 0 {
        return Err(CommandError::new(
            "EXEC_FAILED",
            format!("command exited with status {code}"),
        ));
    }
    Ok(parse_metrics(&output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_info_sections() {
        let info = parse_info("===HOSTNAME===\nnode\n===LOAD===\n0.1 0.2 0.3 1/2\n===CPUS===\n4\n");
        assert_eq!(info.hostname, "node");
        assert_eq!(info.load_avg, "0.1 / 0.2 / 0.3");
        assert_eq!(info.cpus, 4);
    }

    #[test]
    fn calculates_cpu_and_network_deltas() {
        let metrics = parse_metrics("===CPU1===\nT 1 0 0 9 0 0 0 0\n===NET1===\neth0 10 20\n===CPU2===\nT 6 0 0 14 0 0 0 0\n===NET2===\neth0 110 220\n===STATIC===\nMT 100\nMU 25\nDT 200\nDU 50\n");
        assert_eq!(metrics.cpu, 50.0);
        assert_eq!(metrics.net_rx, 100);
        assert_eq!(metrics.net_tx, 200);
        assert_eq!(metrics.mem_percent, 25.0);
        assert_eq!(metrics.disk_percent, 25.0);
    }
}
