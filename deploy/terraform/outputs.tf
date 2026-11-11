output "cluster_name" {
  value = google_container_cluster.main.name
}

output "artifact_registry" {
  description = "Docker repository path for the gateway image."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "redis_url" {
  description = "REDIS_URL for the gateway Secret."
  value       = "redis://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
}

output "database_url" {
  description = "DATABASE_URL for the gateway Secret."
  value       = "postgres://${google_sql_user.app.name}:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/${google_sql_database.app.name}"
  sensitive   = true
}
