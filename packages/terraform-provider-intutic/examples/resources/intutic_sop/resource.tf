resource "intutic_sop" "deploys" {
  title            = "Production deploys"
  markdown_content = file("${path.module}/sops/production-deploys.md")
  risk_tier        = "HIGH"
  complexity_tier  = "TIER_1"
}
