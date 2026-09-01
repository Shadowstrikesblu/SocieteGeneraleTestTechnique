variable "subscription_id" {
  description = "Azure subscription to deploy into."
  type        = string
}

variable "project" {
  description = "Name prefix applied to every resource."
  type        = string
  default     = "sgtest"
}

variable "location" {
  # This subscription is policy-restricted to: norwayeast, germanywestcentral,
  # polandcentral, francecentral, italynorth. France Central also keeps the
  # data in-country, which is the right default for a French institution.
  description = "Azure region."
  type        = string
  default     = "francecentral"
}

variable "frontend_image" {
  description = "Frontend image. Terraform seeds it; CI then deploys immutable SHA tags."
  type        = string
  default     = "ghcr.io/shadowstrikesblu/societegeneraletesttechnique/frontend:latest"
}

variable "backend_image" {
  description = "Backend image. Terraform seeds it; CI then deploys immutable SHA tags."
  type        = string
  default     = "ghcr.io/shadowstrikesblu/societegeneraletesttechnique/backend:latest"
}
