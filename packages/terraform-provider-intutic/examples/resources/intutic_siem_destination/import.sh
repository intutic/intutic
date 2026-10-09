# Import by destination id. Credentials read back masked, so set secret_config
# to the real values. The signing secret is never returned after creation:
# add secret_rotation_triggers to put a new one in state.
terraform import intutic_siem_destination.splunk siemdest_0123456789abcdef
