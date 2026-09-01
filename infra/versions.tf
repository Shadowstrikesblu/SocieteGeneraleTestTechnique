terraform {
  required_version = ">= 1.5"

  # Pinned to a major version: a provider upgrade can change resource
  # behaviour, so it must be a deliberate act, not a surprise on apply.
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}

  # Authentication comes from the local `az login` session. No credential is
  # stored in this repository.
  subscription_id = var.subscription_id
}
