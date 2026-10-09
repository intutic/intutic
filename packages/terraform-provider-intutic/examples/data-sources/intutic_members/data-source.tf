data "intutic_members" "all" {}

locals {
  admins = [for m in data.intutic_members.all.members : m.email if m.is_active && contains(["OWNER", "ADMIN"], m.role)]
}
