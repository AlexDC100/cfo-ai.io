# -*- coding: utf-8 -*-
"""public_market — the GLOBAL PUBLIC MARKETS document class (sibling of
public_summary; status PUBLIC_MARKET; never enters packs/reconcile/consensus).

Deliberately empty of imports: adapters (edgar, ...) and the spine store are
imported explicitly by their consumers so that pulling one adapter never drags
in another lane's dependencies.
"""
