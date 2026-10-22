param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

node "$PSScriptRoot\agent-config.mjs" sync @Arguments
exit $LASTEXITCODE
