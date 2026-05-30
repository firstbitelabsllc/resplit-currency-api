# GCS remote state backend.
#
# The bucket name cannot be interpolated from a variable in the backend block
# (Terraform restriction), so it is supplied at init time via -backend-config.
#
# Initialize with:
#   terraform init -backend-config="bucket=${var.state_bucket}" -backend-config="prefix=resplit-fx/state"
#
# Validate without touching remote state:
#   terraform validate     (run after: terraform init -backend=false)
terraform {
  backend "gcs" {
    # bucket = "<resplit-fx-tfstate-bucket>"   # supplied via -backend-config
    prefix = "resplit-fx/state"
  }
}
