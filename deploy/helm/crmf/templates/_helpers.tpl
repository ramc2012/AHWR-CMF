{{/*
Expand the name of the chart.
*/}}
{{- define "crmf.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
If fullnameOverride is set, use it verbatim.
*/}}
{{- define "crmf.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version label value.
*/}}
{{- define "crmf.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every object.
*/}}
{{- define "crmf.labels" -}}
helm.sh/chart: {{ include "crmf.chart" . }}
{{ include "crmf.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/part-of: crmf
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels (the stable identity subset; must not change across upgrades).
*/}}
{{- define "crmf.selectorLabels" -}}
app.kubernetes.io/name: {{ include "crmf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Backend component labels (full set including component).
*/}}
{{- define "crmf.backend.labels" -}}
{{ include "crmf.labels" . }}
app.kubernetes.io/component: backend
{{- end }}

{{/*
Backend selector labels.
*/}}
{{- define "crmf.backend.selectorLabels" -}}
{{ include "crmf.selectorLabels" . }}
app.kubernetes.io/component: backend
{{- end }}

{{/*
Frontend component labels (full set including component).
*/}}
{{- define "crmf.frontend.labels" -}}
{{ include "crmf.labels" . }}
app.kubernetes.io/component: frontend
{{- end }}

{{/*
Frontend selector labels.
*/}}
{{- define "crmf.frontend.selectorLabels" -}}
{{ include "crmf.selectorLabels" . }}
app.kubernetes.io/component: frontend
{{- end }}

{{/*
ServiceAccount name to use.
*/}}
{{- define "crmf.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (printf "%s-app" (include "crmf.fullname" .)) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Backend image reference (registry/repository:tag).
*/}}
{{- define "crmf.backend.image" -}}
{{- $tag := default .Values.image.tag .Values.backend.image.tag -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.backend.image.repository $tag -}}
{{- end }}

{{/*
Frontend image reference (registry/repository:tag).
*/}}
{{- define "crmf.frontend.image" -}}
{{- $tag := default .Values.image.tag .Values.frontend.image.tag -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.frontend.image.repository $tag -}}
{{- end }}
