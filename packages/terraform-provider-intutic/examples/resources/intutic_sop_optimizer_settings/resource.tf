# Let a manually triggered optimizer run apply strengthening proposals that
# score 0.9 or more without review. Destroying this sets the mode back to
# "manual".
resource "intutic_sop_optimizer_settings" "this" {
  mode           = "auto"
  auto_threshold = 0.9
}
