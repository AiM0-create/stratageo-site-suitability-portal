"""Typed external-provider layer (v1.4.8).

Every Google Places (New) / Aggregate / Routes call goes through this package
and returns a ProviderResult — no raw provider response ever reaches scoring,
and no provider exception ever kills an analysis job.
"""
