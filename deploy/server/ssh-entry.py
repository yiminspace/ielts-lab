#!/usr/bin/env python3
"""Forced command for the unprivileged ielts-deploy SSH key."""
import os
import re
import sys

match = re.fullmatch(r'ielts-release (sha256:[0-9a-f]{64}) (sha256:[0-9a-f]{64})(?: (sha256:[0-9a-f]{64}))? ([0-9a-f]{40})', os.environ.get('SSH_ORIGINAL_COMMAND', ''))
if not match:
    sys.exit('Only a fixed IELTS release command is permitted')
# The root-owned sudo target validates the payload and uses fixed image repositories.
os.execv('/usr/bin/sudo', ['sudo', '-n', '--', '/usr/local/sbin/ielts-release', *(value for value in match.groups() if value is not None)])
