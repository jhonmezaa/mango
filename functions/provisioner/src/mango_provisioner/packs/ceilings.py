"""Ceilings of the packs over account data (D37, D51): what the role behind each broker allows.

A signed manifest of a ``central_only`` pack may only ask for actions of the role behind its
chain's broker: ``Mango-<ns>-BillingReader`` in the payer account (``payer``) or
``Mango-<ns>-ReadOnly`` in every member account (``member``). Asking for anything else fails
the enablement with ``action_outside_broker`` (the role would deny it anyway).

They live in the code of the release, not in the environment of the function: Lambda limits
the whole environment to 4 KB, and with the packs of 2026-11-13 the two lists alone took more
than 3 KB. ``infra/test/packs.test.ts`` keeps them equal, action by action, to the lists the
template builds those roles from (``BILLING_READER_DATA_ACTIONS`` in
``infra/lib/stacks/payer-stack.ts`` and ``MEMBER_READ_ONLY_DATA_ACTIONS`` in
``infra/lib/stacks/member-stack.ts``).
"""

from __future__ import annotations

BROKERED_ACTIONS: frozenset[str] = frozenset(
    (
        "ce:GetCostAndUsage",
        "ce:GetCostForecast",
        "ce:GetAnomalies",
        "ce:GetSavingsPlansCoverage",
        "ce:GetSavingsPlansUtilization",
        "ce:GetSavingsPlansPurchaseRecommendation",
        "ce:GetDimensionValues",
        "ce:GetTags",
        "ce:GetCostCategories",
        "ce:GetUsageForecast",
        "ce:GetCostAndUsageWithResources",
        "ce:GetSavingsPlansUtilizationDetails",
        "ce:GetReservationCoverage",
        "ce:GetReservationUtilization",
        "ce:GetCostAndUsageComparisons",
        "ce:GetCostComparisonDrivers",
        "compute-optimizer:GetEnrollmentStatus",
        "compute-optimizer:GetEC2InstanceRecommendations",
        "compute-optimizer:GetAutoScalingGroupRecommendations",
        "compute-optimizer:GetEBSVolumeRecommendations",
        "compute-optimizer:GetLambdaFunctionRecommendations",
        "compute-optimizer:GetRDSDatabaseRecommendations",
        "compute-optimizer:GetECSServiceRecommendations",
        "compute-optimizer:GetIdleRecommendations",
        "cost-optimization-hub:ListRecommendations",
        "cost-optimization-hub:GetRecommendation",
        "cost-optimization-hub:ListRecommendationSummaries",
        "cost-optimization-hub:ListEfficiencyMetrics",
        "ec2:DescribeInstances",
        "ec2:DescribeVolumes",
        "autoscaling:DescribeAutoScalingGroups",
        "lambda:ListProvisionedConcurrencyConfigs",
        "rds:DescribeDBInstances",
        "rds:DescribeDBClusters",
        "ecs:ListClusters",
        "ecs:ListServices",
        "budgets:ViewBudget",
    )
)
"""``Mango-<ns>-BillingReader``: the ceiling of a manifest of the payer chain."""

MEMBER_ACTIONS: frozenset[str] = frozenset(
    (
        "cloudwatch:GetMetricData",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:DescribeAlarmHistory",
        "logs:DescribeLogGroups",
        "logs:DescribeQueryDefinitions",
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:ListLogAnomalyDetectors",
        "logs:ListAnomalies",
        "cloudtrail:LookupEvents",
        "application-signals:ListServices",
        "application-signals:GetService",
        "application-signals:ListServiceOperations",
        "application-signals:ListServiceDependencies",
        "application-signals:ListServiceDependents",
        "application-signals:ListServiceLevelObjectives",
        "application-signals:ListAuditFindings",
        "application-signals:ListEntityEvents",
        "application-signals:ListServiceStates",
        "application-signals:ListGroupingAttributeDefinitions",
        "cloudwatch:GetMetricStatistics",
        "xray:BatchGetTraces",
        "xray:GetTraceSegmentDestination",
        "synthetics:DescribeCanaries",
        "synthetics:GetCanaryRuns",
        "application-signals:GetServiceLevelObjective",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "elasticache:DescribeServerlessCaches",
        "elasticache:DescribeEvents",
        "elasticache:DescribeCacheEngineVersions",
        "elasticache:DescribeEngineDefaultParameters",
        "elasticache:DescribeServiceUpdates",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeScalingActivities",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeTargetHealth",
        "ecs:ListClusters",
        "ecs:ListServices",
        "ecs:ListTasks",
        "cloudformation:ListStacks",
        "config:GetResourceConfigHistory",
        "ecs:DescribeClusters",
        "ecs:DescribeServices",
        "ecs:ListServiceDeployments",
        "ecs:DescribeServiceDeployments",
        "ecs:DescribeTasks",
        "cloudformation:DescribeStackEvents",
        "rds:DescribeDBInstances",
        "rds:DescribeDBLogFiles",
        "rds:DownloadDBLogFilePortion",
        "rds:DescribeDBClusters",
        "rds:DescribeDBParameters",
        "rds:DescribeDBClusterParameters",
        "rds:DescribePendingMaintenanceActions",
        "rds:DescribeDBSnapshots",
        "rds:DescribeDBClusterSnapshots",
        "rds:DescribeEvents",
        "pi:GetResourceMetrics",
        "pi:DescribeDimensionKeys",
        "pi:ListAvailableResourceMetrics",
    )
)
"""``Mango-<ns>-ReadOnly``: the ceiling of a manifest of the member chain."""
