output "frontend_url" {
  description = "Public URL of the application."
  value       = "https://${azurerm_container_app.frontend.ingress[0].fqdn}"
}

output "backend_internal_fqdn" {
  description = "Backend address inside the environment. Not routable from the internet."
  value       = azurerm_container_app.backend.ingress[0].fqdn
}

output "resource_group" {
  description = "Resource group holding every resource in this stack."
  value       = azurerm_resource_group.main.name
}
