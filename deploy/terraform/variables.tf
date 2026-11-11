variable "project_id" {
  description = "GCP project that hosts the gateway."
  type        = string
}

variable "region" {
  description = "Region for all regional resources."
  type        = string
  default     = "asia-south1"
}

variable "name" {
  description = "Prefix applied to resource names."
  type        = string
  default     = "tollgate"
}

variable "redis_memory_gb" {
  description = "Memorystore capacity in GB."
  type        = number
  default     = 1
}

variable "redis_tier" {
  description = "BASIC or STANDARD_HA. STANDARD_HA keeps rate-limit state across a node failure."
  type        = string
  default     = "STANDARD_HA"
}

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_availability_type" {
  description = "ZONAL or REGIONAL."
  type        = string
  default     = "ZONAL"
}

variable "deletion_protection" {
  description = "Protect stateful resources from accidental deletion."
  type        = bool
  default     = true
}
