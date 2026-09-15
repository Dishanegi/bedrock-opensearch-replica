# Dense vs. Sparse (ASE) vs. Hybrid vs. Keyword — retrieval benchmark

Run against NextGen, 55 labeled queries, k=10. See docs/sparse-vs-dense-benchmark-plan.md for methodology.

## identifier

| Mode | Recall@10 | MRR | NDCG@10 | n |
|---|---|---|---|---|
| Dense (Bedrock/Titan) | 0.87 | 0.87 | 0.87 | 15 |
| Sparse (ASE) | 0.80 | 0.80 | 0.80 | 15 |
| Hybrid | 0.87 | 0.87 | 0.87 | 15 |
| Keyword (BM25) | 0.87 | 0.87 | 0.87 | 15 |

## paraphrase

| Mode | Recall@10 | MRR | NDCG@10 | n |
|---|---|---|---|---|
| Dense (Bedrock/Titan) | 1.00 | 1.00 | 1.00 | 15 |
| Sparse (ASE) | 0.80 | 0.80 | 0.80 | 15 |
| Hybrid | 1.00 | 1.00 | 1.00 | 15 |
| Keyword (BM25) | 0.80 | 0.75 | 0.76 | 15 |

## log

| Mode | Recall@10 | MRR | NDCG@10 | n |
|---|---|---|---|---|
| Dense (Bedrock/Titan) | 0.80 | 0.80 | 0.80 | 15 |
| Sparse (ASE) | 0.73 | 0.73 | 0.73 | 15 |
| Hybrid | 0.87 | 0.81 | 0.82 | 15 |
| Keyword (BM25) | 0.67 | 0.67 | 0.67 | 15 |

## mixed

| Mode | Recall@10 | MRR | NDCG@10 | n |
|---|---|---|---|---|
| Dense (Bedrock/Titan) | 0.80 | 0.72 | 0.74 | 10 |
| Sparse (ASE) | 0.70 | 0.70 | 0.70 | 10 |
| Hybrid | 0.90 | 0.75 | 0.79 | 10 |
| Keyword (BM25) | 0.70 | 0.70 | 0.70 | 10 |

## Overall

| Mode | Recall@10 | MRR | NDCG@10 | n |
|---|---|---|---|---|
| Dense (Bedrock/Titan) | 0.87 | 0.86 | 0.86 | 55 |
| Sparse (ASE) | 0.76 | 0.76 | 0.76 | 55 |
| Hybrid | 0.91 | 0.87 | 0.88 | 55 |
| Keyword (BM25) | 0.76 | 0.75 | 0.75 | 55 |
