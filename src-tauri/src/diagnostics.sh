LC_ALL=C; export LC_ALL
# All fast counters share one measured window and one SSH operation.
overview_snapshot() {
    phase=$1
    printf '[time%s]\n' "$phase"; cat /proc/uptime 2>/dev/null
    printf '[cpu%s]\n' "$phase"; awk '/^cpu[0-9]* /' /proc/stat 2>/dev/null
    printf '[net%s]\n' "$phase"; sed -n '3,$p' /proc/net/dev 2>/dev/null | tr ':' ' '
    printf '[disk%s]\n' "$phase"
    for d in /sys/block/*; do
        case "${d##*/}" in loop*|ram*|zram*|fd*|sr*) continue;; esac
        test -r "$d/stat" || continue
        set -- "$d"/slaves/*; test -e "$1" && continue
        printf '%s ' "${d##*/}"; cat "$d/stat" 2>/dev/null
    done
    printf '[process%s]\n' "$phase"
    # Linux stat's command can contain spaces and parentheses. Strip through
    # the last closing parenthesis before indexing the numeric fields.
    if test -n "$overview_page"; then awk -v page="$overview_page" '
      { end=0; for(i=length($0);i>0;i--) if(substr($0,i,2)==") "){end=i;break}
        if(!end) next; name=substr($0,index($0,"(")+1,end-index($0,"(")-1);
        id=substr($0,1,index($0," ")-1); tail=substr($0,end+2); split(tail,a," ");
        gsub(/[\t\r\n]/," ",name);
        if(a[12] ~ /^[0-9]+$/ && a[22] ~ /^[0-9]+$/)
          printf "%s\t%s\t%.0f\t%.0f\t%s\n",id,a[20],a[12]+a[13],a[22]*page/1024,name;
      }' /proc/[0-9]*/stat 2>/dev/null; fi
}
overview_page=$(getconf PAGESIZE 2>/dev/null)
case "$overview_page" in ''|*[!0-9]*|0) overview_page=$(awk '/^KernelPageSize:/ {printf "%.0f", $2*1024; exit}' /proc/self/smaps 2>/dev/null);; esac
overview_snapshot 1
sleep 1
overview_snapshot 2
test ! -r /proc/net/dev || printf '[net-ok]\n'
if test -n "$overview_page" && test -r /proc/self/stat; then printf '[processes-ok]\n'; fi
printf '[memory]\n'; cat /proc/meminfo 2>/dev/null
printf '[load]\n'; cat /proc/loadavg 2>/dev/null
# A stalled network mount must not stall every performance reading.
if command -v timeout >/dev/null 2>&1; then
    overview_df=$(timeout -k 1 2 df -Pk -l 2>/dev/null)
    if test $? -eq 0; then printf '[filesystems-ok]\n[filesystems]\n%s\n' "$overview_df"; fi
fi
if test "$overview_workloads" = 1; then
    overview_warnings=''
    if command -v timeout >/dev/null 2>&1; then
        overview_services=$(timeout -k 1 2 systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null)
        if test $? -eq 0; then
            printf '[services-ok]\n[services]\n'
            printf '%s\n' "$overview_services" | awk 'NF>=4 {count[$3]++} END {for(s in count) printf "%s\t%d\n",s,count[s]}'
        else overview_warnings="Services unavailable or systemd unsupported"; fi
        overview_containers=$(timeout -k 1 2 docker ps -a --format '{{.State}}|{{.Status}}' 2>/dev/null)
        if test $? -eq 0; then
            printf '[containers-ok]\n[containers]\n'
            printf '%s\n' "$overview_containers" | awk -F '|' 'NF>=2 {state[$1]++; if($2 ~ /\(unhealthy\)/) health["unhealthy"]++; else if($2 ~ /\(healthy\)/) health["healthy"]++; else if($2 ~ /health: starting/) health["health starting"]++} END {for(s in state) printf "%s\t%d\n",s,state[s]; for(s in health) printf "%s\t%d\n",s,health[s]}'
        else overview_warnings="$overview_warnings
Docker unavailable or daemon access denied"; fi
        overview_ports=$(timeout -k 1 2 ss -H -lntu 2>/dev/null)
        if test $? -eq 0; then
            printf '[listeners-ok]\n[listeners]\n'
            printf '%s\n' "$overview_ports" | awk 'NF>=5 {count[$1]++; ports[$1 " " $5]++} END {for(s in count) printf "%s listeners\t%d\n",s,count[s]; n=0; for(s in ports) if(n++<8) printf "%s\t%d\n",s,ports[s]}'
        else overview_warnings="$overview_warnings
Listening sockets unavailable"; fi
    else overview_warnings='Filesystem and workload reads require timeout on this host'; fi
    printf '[workload-warnings]\n%s\n' "$overview_warnings" | sed '/^$/d'
fi
true
