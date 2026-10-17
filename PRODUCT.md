# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

User selected a lightweight browser UI without frontend dependencies and direct implementation in code. Compiler: C++20 and CMake. Local service: Node.js standard library. No hosted deployment is required: this is a local C++ development project.

## Users

Developers exploring image-filter compilation, compiler internals, and NVIDIA PTX through an interactive local workbench.

## Product Purpose

PixelPTX compiles tiny scalar image-processing expressions into NVIDIA PTX and makes the compilation stages inspectable alongside image results.

## Operating Context

The workbench runs locally, with optional on-demand NVIDIA execution through Azure Batch Spot. Local rendering remains on the CPU. Only an explicit GPU run starts cloud compute; each run must collect its result and clean up its temporary resources. The generated PTX remains the primary target.

## Capabilities and Constraints

C++ lexer/parser/AST, conservative float32 optimizer, register IR, PTX generator, source mapping, CPU reference evaluation, visual stage navigation, optional offline PTXAS/CUBIN/SASS inspection, and an optional CUDA Driver API runner on one temporary Azure Batch Spot T4. The UI makes compiler stages and image results inspectable. Only CUDA event measurements are labeled as GPU kernel time.

## Evidence on Hand

Demonstration image content is synthetic; user images may be loaded locally. Tests are project-owned evidence, separate from hardware validation.

## Product Principles

- Make compiler transformations explainable.
- Generate real PTX rather than decorative snippets.
- Label local execution and verification precisely.
- Keep the first version easy to build and run offline.
