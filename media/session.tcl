# The extension sends one base64 encoded UTF-8 Tcl command per line. User values
# are separately quoted; no shell or untrusted Tcl program is evaluated.
fconfigure stdin -encoding utf-8 -translation lf
fconfigure stdout -encoding utf-8 -translation lf -buffering line
puts "__NVC_READY__|$now"
while {[gets stdin line] >= 0} {
  set status [catch {
    set script [encoding convertfrom utf-8 [binary decode base64 $line]]
    uplevel #0 $script
  } result]
  puts "__NVC_RESPONSE__|$status|$now|[binary encode base64 -maxlen 0 [encoding convertto utf-8 $result]]"
  flush stdout
}
