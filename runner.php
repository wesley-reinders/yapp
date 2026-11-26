<?php

$projectPath = getcwd();

require $projectPath . '/vendor/autoload.php';

$app = require $projectPath . '/bootstrap/app.php';

$kernel = $app->make(
    Illuminate\Contracts\Console\Kernel::class
);

$kernel->bootstrap();

$cloner = new \Symfony\Component\VarDumper\Cloner\VarCloner();
$dumper = new \Symfony\Component\VarDumper\Dumper\CliDumper('php://stdout');
$dumper->setColors(true);

\Symfony\Component\VarDumper\VarDumper::setHandler(
    static function ($value) use ($cloner, $dumper): void {
        $dumper->dump($cloner->cloneVar($value));
    }
);
